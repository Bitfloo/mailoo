/**
 * One anonymous install count after the stdio or HTTP server is up.
 *
 * Off unless MAILOO_INSTALL_COUNTER is explicitly on. With no
 * MAILOO_INSTALL_COUNTER_URL nothing leaves the machine: there is no default
 * host. The body is four aggregate fields and nothing from a mailbox. A
 * generation file under the state directory stops a second send. CI and the
 * test runner are not installs; release-day npm installs are CI.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { xdg } from '../config/xdg.js';
import { PRIVATE_FILE_MODE } from '../utils/atomic-write.js';
import { acquireClaim, errnoCode, releaseClaim } from '../utils/file-claim.js';
import { isLoopbackHost } from '../utils/loopback.js';

export const INSTALL_COUNT_PRODUCT = 'mailoo';
export const INSTALL_COUNT_EVENT = 'install' as const;
export const INSTALL_COUNT_GENERATION = 1;

/**
 * A stuck collector must not keep the socket. One attempt per process; a
 * refusal is retried on the next server start, not in a loop.
 */
export const INSTALL_COUNT_TIMEOUT_MS = 3_000;

/**
 * A holder's work is the fetch, bounded by the timeout above, plus one marker
 * write. Only a crashed holder's lock outlives that, so the window is a
 * multiple of the timeout and a live holder is never taken over.
 */
export const INSTALL_COUNT_CLAIM_STALE_MS = INSTALL_COUNT_TIMEOUT_MS * 4;

/** Above this, the number is not a Node major. Refuse it instead of sending a stray integer. */
const MAX_NODE_MAJOR = 99;

const MARKER_NAME = 'install-count';
const SWITCH_ENV = 'MAILOO_INSTALL_COUNTER';
const URL_ENV = 'MAILOO_INSTALL_COUNTER_URL';
const USER_AGENT = 'mailoo' as const;
export const ON_VALUES = new Set(['1', 'true', 'on', 'yes']);

/** The conventional negatives: they keep the switch off and do not mark a CI run. */
export const NEGATIVE_VALUES = new Set(['0', 'false', 'no', 'off']);

/** Package versions only. Anything else might be a path or an address that leaked into the field. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface InstallCountPayload {
  product: typeof INSTALL_COUNT_PRODUCT;
  version: string;
  event: typeof INSTALL_COUNT_EVENT;
  node_major: number;
}

export interface InstallCountRequest {
  method: 'POST';
  headers: {
    'content-type': 'application/json';
    'user-agent': typeof USER_AGENT;
  };
  body: string;
  redirect: 'manual';
  credentials: 'omit';
  signal: AbortSignal;
}

export interface InstallCountResponse {
  status: number;
  body: { cancel: () => Promise<void> } | null;
}

export type InstallCountFetch = (
  url: string,
  init: InstallCountRequest,
) => Promise<InstallCountResponse>;

export type InstallCountReason =
  | 'disabled'
  | 'automation'
  | 'no-endpoint'
  | 'rejected'
  | 'already'
  | 'refused'
  | 'sent';

export interface InstallCountResult {
  sent: boolean;
  reason: InstallCountReason;
}

export interface RecordInstallInput {
  version: string;
  nodeMajor: number;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  fetchImpl?: InstallCountFetch;
}

export function installCountPayload(
  version: string,
  nodeMajor: number,
): InstallCountPayload | undefined {
  if (!VERSION_PATTERN.test(version)) return undefined;
  if (!Number.isInteger(nodeMajor) || nodeMajor < 0 || nodeMajor > MAX_NODE_MAJOR) return undefined;
  return {
    product: INSTALL_COUNT_PRODUCT,
    version,
    event: INSTALL_COUNT_EVENT,
    node_major: nodeMajor,
  };
}

function switchedOn(raw: string | undefined): boolean {
  if (raw == null) return false;
  return ON_VALUES.has(raw.trim().toLowerCase());
}

/** A blank VITEST is not the runner. NODE_ENV=test is. */
function isTestRun(env: NodeJS.ProcessEnv): boolean {
  if (env.VITEST != null && env.VITEST.trim() !== '') return true;
  return env.NODE_ENV?.trim() === 'test';
}

/** Any CI value counts except the conventional negatives. */
function isCi(raw: string | undefined): boolean {
  if (raw == null) return false;
  const ci = raw.trim().toLowerCase();
  return ci !== '' && !NEGATIVE_VALUES.has(ci);
}

function skippedAutomation(env: NodeJS.ProcessEnv): boolean {
  return isCi(env.CI) || isTestRun(env);
}

/**
 * Cleartext is refused except to this machine. Redirects are not followed:
 * the payload may go only to the host the operator named. Userinfo is refused
 * so a URL cannot carry a credential.
 */
function endpoint(raw: string): string | undefined {
  const url = URL.parse(raw.trim());
  if (!url || url.hostname === '') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  const https = url.protocol === 'https:';
  const loopbackHttp = url.protocol === 'http:' && isLoopbackHost(url.hostname);
  if (!https && !loopbackHttp) return undefined;
  return raw.trim();
}

function markerFile(stateDir: string): string {
  return path.join(stateDir, MARKER_NAME);
}

async function readMarker(file: string): Promise<'absent' | 'current' | 'other' | 'unreadable'> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.trim() === String(INSTALL_COUNT_GENERATION) ? 'current' : 'other';
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return 'absent';
    return 'unreadable';
  }
}

async function writeMarker(file: string): Promise<void> {
  await fs.writeFile(file, `${INSTALL_COUNT_GENERATION}\n`, {
    encoding: 'utf8',
    mode: PRIVATE_FILE_MODE,
  });
}

function notSent(reason: Exclude<InstallCountReason, 'sent'>): InstallCountResult {
  return { sent: false, reason };
}

async function liveFetch(url: string, init: InstallCountRequest): Promise<InstallCountResponse> {
  // Tests inject a fetch. This refuses a real socket when this process is the runner.
  if (isTestRun(process.env)) return { status: 0, body: null };
  try {
    const response = await fetch(url, init);
    return { status: response.status, body: response.body };
  } catch {
    // Not chained: fetch errors quote the URL, which may hold a collector credential.
    return { status: 0, body: null };
  }
}

function accepted(status: number): boolean {
  return status >= 200 && status < 300;
}

export async function recordInstall(input: RecordInstallInput): Promise<InstallCountResult> {
  try {
    if (skippedAutomation(input.env)) return notSent('automation');
    if (!switchedOn(input.env[SWITCH_ENV])) return notSent('disabled');
    const rawUrl = input.env[URL_ENV];
    if (rawUrl == null || rawUrl.trim() === '') return notSent('no-endpoint');
    const url = endpoint(rawUrl);
    if (url === undefined) return notSent('rejected');
    const payload = installCountPayload(input.version, input.nodeMajor);
    if (payload === undefined) return notSent('rejected');

    const file = markerFile(input.stateDir);
    const lock = `${file}.lock`;
    // The exclusive create fails with ENOENT in a state dir that does not exist yet.
    await fs.mkdir(input.stateDir, { recursive: true });
    const token = await acquireClaim(lock, INSTALL_COUNT_CLAIM_STALE_MS);
    if (token === undefined) return notSent('already');
    try {
      // Read under the claim: a start that read before it could post a second time.
      const marker = await readMarker(file);
      if (marker === 'current') return notSent('already');
      if (marker === 'unreadable') return notSent('refused');

      const fetchImpl = input.fetchImpl ?? liveFetch;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(payload),
        redirect: 'manual',
        credentials: 'omit',
        signal: AbortSignal.timeout(INSTALL_COUNT_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => undefined);
      if (!accepted(response.status)) return notSent('refused');
      await writeMarker(file);
    } finally {
      // A failed release must not turn a recorded install into a refusal; the stale window clears the lock.
      await releaseClaim(lock, token).catch(() => undefined);
    }
    return { sent: true, reason: 'sent' };
  } catch {
    // Fetch and filesystem errors quote paths and URLs, and a throw would fail server startup.
    // Callers only see the reason.
    return notSent('refused');
  }
}

/**
 * Counts this process when it is the stdio or HTTP server. CLI commands must
 * not call this. A collector failure must not fail startup.
 */
export async function noteInstall(version: string): Promise<void> {
  await recordInstall({
    version,
    nodeMajor: Number.parseInt(process.versions.node, 10),
    env: process.env,
    stateDir: xdg.state,
  });
}
