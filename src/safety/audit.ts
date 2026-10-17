/**
 * Audit logger — append-only JSON Lines log for all write operations.
 *
 * Logs are stored at the XDG data directory:
 *   ~/.local/share/mailoo/audit.log
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { xdg } from '../config/xdg.js';

import type { AuditEntry } from '../types/index.js';

const AUDIT_LOG_PATH = path.join(xdg.data, 'audit.log');

/** Fields redacted from audit params to protect sensitive data. */
const REDACTED_FIELDS = new Set([
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
]);

function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  Object.entries(params).forEach(([key, value]) => {
    if (REDACTED_FIELDS.has(key)) {
      cleaned[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      cleaned[key] = redactParams(value as Record<string, unknown>);
    } else {
      cleaned[key] = value;
    }
  });
  return cleaned;
}

/** Entries carry recipients and subjects, so only the owner may read them. */
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/** Set after the first write that checked existing modes. */
let modesChecked = false;

function hasGroupOrOtherBits(mode: number): boolean {
  // eslint-disable-next-line no-bitwise
  return (mode & 0o077) !== 0;
}

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
      account,
      params: redactParams(params),
      result,
      ...(error ? { error } : {}),
    };
    await appendLine(`${JSON.stringify(entry)}\n`);
  } catch (err) {
    // The entry itself stays out of stderr: it holds recipients and subjects.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[mailoo] audit log write failed: ${message}\n`);
  }
}

const audit = { log, AUDIT_LOG_PATH } as const;

export default audit;
