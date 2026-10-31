/**
 * Audit logger — append-only JSON Lines log for all write operations.
 *
 * Logs are stored at the XDG data directory:
 *   ~/.local/share/mailoo/audit.log
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { types } from 'node:util';

import { xdg } from '../config/xdg.js';
import type { AuditEntry } from '../types/index.js';
import hasGroupOrOtherBits from '../utils/file-mode.js';

const AUDIT_LOG_PATH = path.join(xdg.data, 'audit.log');

/** Lower case, with `_` and `-` removed, so `Password` and `access-token` match too. */
function normaliseField(key: string): string {
  return key.toLowerCase().replaceAll(/[_-]/g, '');
}

/** Fields redacted from audit params to protect sensitive data. */
const REDACTED_FIELDS = new Set(
  [
    'password',
    'body',
    'bodyText',
    'bodyHtml',
    'content_base64',
    'clientSecret',
    'client_secret',
    'refreshToken',
    'refresh_token',
    'accessToken',
    'access_token',
    'idToken',
    'id_token',
  ].map(normaliseField),
);

/**
 * Tool params nest a few levels at most (attachment objects in an array). The limit bounds the
 * walk, so a param nested deeper than the stack can hold no longer throws and loses the entry.
 */
export const PARAMS_MAX_DEPTH = 16;

/**
 * Userinfo, query and fragment can hold a password or a token, so a URL is written as scheme, host
 * and path, followed by `?[REDACTED]` when any of them was there. Not `origin`: it is "null" for a
 * scheme the URL standard does not know, such as `redis:`.
 */
function urlForEntry(url: URL): string {
  // Copy through the intrinsic getter so subclasses cannot supply executable accessors.
  const href = Object.getOwnPropertyDescriptor(URL.prototype, 'href')?.get;
  const safe = new URL(href?.call(url));
  // mailto:, data: and javascript: have no host. Joining `//` would keep the address in the path.
  if (safe.host === '' && !safe.href.startsWith(`${safe.protocol}//`)) {
    return `${safe.protocol}[REDACTED]`;
  }
  const kept = `${safe.protocol}//${safe.host}${safe.pathname}`;
  return safe.username || safe.password || safe.search || safe.hash ? `${kept}?[REDACTED]` : kept;
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Only arrays and plain objects are walked. A Date is written as its text, a URL as urlForEntry
 * gives it, and bytes never are. Any other object becomes a marker rather than String(value): its
 * own toString can throw or print a secret, and walking its keys would write it as {}. `ancestors`
 * holds the containers on the path down from params, so only a reference back to one of them is a
 * cycle; an object two params share is written under each.
 */
function redactValue(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'function') return '[Function]';
  if (typeof value !== 'object' || value === null) return value;
  if (types.isProxy(value)) return '[Proxy]';
  if (types.isDate(value)) {
    return Number.isNaN(Date.prototype.getTime.call(value))
      ? 'Invalid Date'
      : Date.prototype.toISOString.call(value);
  }
  if (value instanceof URL) return urlForEntry(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[Binary]';
  if (!Array.isArray(value) && !isPlainObject(value)) return '[Object]';
  if (ancestors.has(value)) return '[Circular]';
  if (depth > PARAMS_MAX_DEPTH) return '[Truncated]';
  ancestors.add(value);
  const cleaned = Array.isArray(value)
    ? // eslint-disable-next-line @typescript-eslint/no-use-before-define -- redactItems calls back into this function
      redactItems(value, depth, ancestors)
    : // eslint-disable-next-line @typescript-eslint/no-use-before-define -- the two recurse into each other
      redactEntries(value, depth, ancestors);
  ancestors.delete(value);
  return cleaned;
}

/** Own descriptors avoid array accessors and values inherited from its prototype. */
function redactItems(items: unknown[], depth: number, ancestors: WeakSet<object>): unknown[] {
  const cleaned: unknown[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(items, String(index));
    cleaned[index] =
      descriptor && !('value' in descriptor)
        ? '[Accessor]'
        : redactValue(descriptor?.value, depth + 1, ancestors);
  }
  return cleaned;
}

function assignOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty, not assignment: a `__proto__` key must stay a field, not become the prototype.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** A sensitive key masks its whole value before anything reads it. */
function redactEntries(
  params: object,
  depth: number,
  ancestors: WeakSet<object>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = Object.create(null);
  Reflect.ownKeys(params).forEach((key) => {
    if (typeof key !== 'string') return;
    const descriptor = Object.getOwnPropertyDescriptor(params, key);
    if (!descriptor) return;
    if (REDACTED_FIELDS.has(normaliseField(key))) {
      assignOwn(cleaned, key, '[REDACTED]');
      return;
    }
    // A getter or a Proxy trap would run if the value were read. The marker stands in for it.
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      assignOwn(cleaned, key, '[Accessor]');
      return;
    }
    assignOwn(cleaned, key, redactValue(descriptor.value, depth + 1, ancestors));
  });
  return cleaned;
}

function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  if (types.isProxy(params)) return { value: '[Proxy]' };
  return redactEntries(params, 0, new WeakSet([params]));
}

/** Entries carry recipients and subjects, so only the owner may read them. */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Existing modes are tightened once per process. A write that fails leaves
 * this unset, so the next write checks them again.
 */
let modesChecked = false;

async function appendLine(line: string): Promise<void> {
  const dir = path.dirname(AUDIT_LOG_PATH);
  // Not cached: a data directory removed while the server runs is recreated.
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (!modesChecked) {
    // lstat: a symlinked data directory is the operator's, not one Mailoo made.
    const dirInfo = await fs.lstat(dir);
    if (dirInfo.isDirectory() && hasGroupOrOtherBits(dirInfo.mode)) {
      await fs.chmod(dir, PRIVATE_DIR_MODE);
    }
  }
  const handle = await fs.open(AUDIT_LOG_PATH, 'a', PRIVATE_FILE_MODE);
  try {
    if (!modesChecked) {
      const fileInfo = await handle.stat();
      if (hasGroupOrOtherBits(fileInfo.mode)) await handle.chmod(PRIVATE_FILE_MODE);
    }
    await handle.appendFile(line, 'utf-8');
  } finally {
    await handle.close();
  }
  modesChecked = true;
}

/**
 * Tools log the account argument as given: '' when it was omitted for the default,
 * or an address or another case. The entry names the account that ran instead.
 */
let resolveAccount: ((key: string) => string) | undefined;

function setAccountResolver(resolver: (key: string) => string): void {
  resolveAccount = resolver;
}

function accountForEntry(account: string): string {
  if (!resolveAccount) return account;
  try {
    return resolveAccount(account);
  } catch {
    // An account that does not resolve is what the failed call was given, so it stays as given.
    return account;
  }
}

/**
 * Append a single audit entry to the log file.
 * Creates the directory and file if they don't exist.
 *
 * Never rejects: tools audit after their side effect, and a rejection would
 * report a delivered send or finished move as failed, inviting a retry.
 */
async function log(
  tool: string,
  account: string,
  params: Record<string, unknown>,
  result: 'ok' | 'error',
  error?: string,
): Promise<void> {
  try {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      tool,
      account: accountForEntry(account),
      params: redactParams(params),
      result,
      ...(error ? { error } : {}),
    };
    await appendLine(`${JSON.stringify(entry)}\n`);
  } catch {
    // The entry itself stays out of stderr: it holds recipients and subjects.
    process.stderr.write('[mailoo] audit log write failed: entry could not be written\n');
  }
}

const audit = { log, setAccountResolver, AUDIT_LOG_PATH } as const;

export default audit;
