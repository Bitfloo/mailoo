/** Input validation and sanitization utilities. */

import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { BlockList, isIP } from 'node:net';

import { z } from 'zod';

/**
 * HTML5 email production — no regex lookaheads.
 * Zod's default `.email()` emits a lookahead pattern that llama.cpp GBNF cannot compile.
 */
export const recipientEmail = z.string().regex(z.regexes.html5Email);

/** IMAP UID is an nz-number: 1 through 2^32-1, with no leading zeros (RFC 9051). */
const MAX_MESSAGE_UID = 4_294_967_295;

/**
 * Validate and sanitize an IMAP mailbox name.
 * Rejects empty names, control characters, and IMAP wildcards (`*`, `%`).
 * @param name - The mailbox name to validate.
 * @returns The trimmed mailbox name.
 */
export function sanitizeMailboxName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Mailbox name must not be empty');
  }
  if (trimmed.includes('*') || trimmed.includes('%')) {
    throw new Error('Mailbox name must not contain IMAP wildcard characters (* or %)');
  }
  /* eslint-disable no-control-regex */
  // imapflow quotes non-atom mailbox names and refuses CR/LF/NUL; only control
  // characters are rejected here, for a clearer error.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in mailbox names
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error('Mailbox name must not contain control characters');
  }
  /* eslint-enable no-control-regex */
  return trimmed;
}

/**
 * Exactly one IMAP UID (bounds: MAX_MESSAGE_UID).
 * A sequence-set (`1:*`, `1,2`) or a non-integer prefix addresses a different
 * message than the single id the caller passed.
 * @param emailId - Caller-supplied message id.
 * @returns The same string when it is a single UID.
 */
export function parseMessageUid(emailId: string): string {
  if (!/^[1-9][0-9]{0,9}$/.test(emailId)) {
    throw new Error('Email ID must be a positive integer UID');
  }
  const uid = Number(emailId);
  if (!Number.isSafeInteger(uid) || uid > MAX_MESSAGE_UID) {
    throw new Error('Email ID must be a positive integer UID');
  }
  return emailId;
}

/**
 * Strip control characters from an IMAP search query.
 * Removes ASCII 0-31 except tab (0x09) and newline (0x0A).
 * @param query - The raw search query.
 * @returns The sanitized query string.
 */
export function sanitizeSearchQuery(query: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — sanitize control chars from user input
  const cleaned = query.replace(/[\x00-\x08\x0B-\x1F]/g, '').trim(); // eslint-disable-line no-control-regex
  if (cleaned.length === 0) {
    throw new Error('Search query must not be empty after sanitization');
  }
  return cleaned;
}

/**
 * Non-global addresses a webhook must not reach unless the operator opts in.
 * IPv4: this-host, RFC1918, loopback, link-local (includes cloud metadata).
 * IPv6: unspecified, loopback, unique-local, link-local.
 */
const BLOCKED_WEBHOOK_ADDRESSES = new BlockList();
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('0.0.0.0', 8, 'ipv4');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('10.0.0.0', 8, 'ipv4');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('172.16.0.0', 12, 'ipv4');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('192.168.0.0', 16, 'ipv4');
// IANA IPv4/IPv6 Special-Purpose Address Registries: these are not ordinary
// global unicast (shared address space, protocol assignments, benchmarking,
// reserved, site-local).
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('100.64.0.0', 10, 'ipv4');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('192.0.0.0', 24, 'ipv4');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('198.18.0.0', 15, 'ipv4');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('240.0.0.0', 4, 'ipv4');
BLOCKED_WEBHOOK_ADDRESSES.addAddress('::', 'ipv6');
BLOCKED_WEBHOOK_ADDRESSES.addAddress('::1', 'ipv6');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('fc00::', 7, 'ipv6');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('fec0::', 10, 'ipv6');

const METADATA_WEBHOOK_HOSTS = new Set(['metadata.google.internal', 'metadata.goog']);

/** How long a webhook hostname lookup may take before it is refused. */
export const WEBHOOK_LOOKUP_TIMEOUT_MS = 2_000;

/** A resolver failure can repeat the timeout sentence; callers match this class. */
export class WebhookLookupTimeoutError extends Error {
  constructor() {
    super('Webhook address lookup timed out');
    this.name = 'WebhookLookupTimeoutError';
  }
}

export interface WebhookUrlOptions {
  /** When true, loopback and non-global addresses are allowed. Protocol is still checked. */
  allowPrivate?: boolean;
}

export interface WebhookResolveOptions extends WebhookUrlOptions {
  /** Test seam. Production uses DNS. */
  lookup?: (hostname: string) => Promise<readonly string[]>;
  lookupTimeoutMs?: number;
}

function stripHostBrackets(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function parseIpv6Hextets(host: string): number[] | undefined {
  let text = host;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted?.[1] && dotted[2]) {
    const octets = dotted[2].split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
      return undefined;
    }
    const high = octets[0] * 256 + octets[1];
    const low = octets[2] * 256 + octets[3];
    text = `${dotted[1]}${high.toString(16)}:${low.toString(16)}`;
  }

  const sides = text.split('::');
  if (sides.length > 2) return undefined;

  const parseSide = (side: string): number[] | undefined => {
    if (side.length === 0) return [];
    const parts = side.split(':');
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
    return parts.map((part) => Number.parseInt(part, 16));
  };

  const left = parseSide(sides[0] ?? '');
  if (!left) return undefined;
  if (sides.length === 1) return left.length === 8 ? left : undefined;
  const right = parseSide(sides[1] ?? '');
  if (!right) return undefined;
  const missing = 8 - left.length - right.length;
  if (missing <= 0) return undefined;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function ipv4FromHextets(high: number, low: number): string {
  return `${Math.floor(high / 256)}.${high % 256}.${Math.floor(low / 256)}.${low % 256}`;
}

/**
 * IPv4 carried in ::ffff:0:0/96 (mapped), ::/96 (compatible),
 * 64:ff9b::/96 (NAT64), or 2002::/16 (6to4).
 */
function embeddedIpv4(host: string): string | undefined {
  const words = parseIpv6Hextets(host);
  if (words?.length !== 8) return undefined;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
  if (
    w0 === 0 &&
    w1 === 0 &&
    w2 === 0 &&
    w3 === 0 &&
    w4 === 0 &&
    (w5 === 0xffff || w5 === 0) &&
    w6 !== undefined &&
    w7 !== undefined
  ) {
    return ipv4FromHextets(w6, w7);
  }
  if (
    w0 === 0x64 &&
    w1 === 0xff9b &&
    w2 === 0 &&
    w3 === 0 &&
    w4 === 0 &&
    w5 === 0 &&
    w6 !== undefined &&
    w7 !== undefined
  ) {
    return ipv4FromHextets(w6, w7);
  }
  if (w0 === 0x2002 && w1 !== undefined && w2 !== undefined) return ipv4FromHextets(w1, w2);
  return undefined;
}

function isBlockedWebhookHost(host: string): boolean {
  const bare = stripHostBrackets(host);
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true;
  if (METADATA_WEBHOOK_HOSTS.has(bare)) return true;
  const embedded = embeddedIpv4(bare);
  if (embedded) return BLOCKED_WEBHOOK_ADDRESSES.check(embedded, 'ipv4');
  if (isIP(bare) === 4) return BLOCKED_WEBHOOK_ADDRESSES.check(bare, 'ipv4');
  if (isIP(bare) === 6) return BLOCKED_WEBHOOK_ADDRESSES.check(bare, 'ipv6');
  return false;
}

/**
 * Validate a webhook URL.
 * Ensures the URL uses http(s) and does not point to a loopback, private,
 * link-local, or metadata address unless `allowPrivate` is set.
 * @param url - The webhook URL to validate.
 * @param options - Opt in to non-global addresses.
 */
export function validateWebhookUrl(url: string, options: WebhookUrlOptions = {}): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Webhook URL must use http or https protocol, got ${parsed.protocol}`);
  }

  if (options.allowPrivate) return;

  const bare = stripHostBrackets(parsed.hostname);
  if (isBlockedWebhookHost(bare)) {
    throw new Error(`Webhook URL must not point to a loopback or private address: ${bare}`);
  }
}

async function defaultWebhookLookup(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function refuseWebhookAddress(hostname: string): NodeJS.ErrnoException {
  return new Error(`Webhook URL must not point to a loopback or private address: ${hostname}`);
}

/**
 * `lookup` for `http.request` / `https.request`.
 * Every answer is checked, then returned, so the socket connects to the
 * checked address rather than a later resolution of the same name.
 */
export function createWebhookConnectLookup(options: WebhookResolveOptions = {}): LookupFunction {
  const allowPrivate = options.allowPrivate === true;
  const resolve = options.lookup ?? defaultWebhookLookup;
  return async (hostname, lookupOptions, callback) => {
    const fail = (err: NodeJS.ErrnoException): void => {
      callback(err, []);
    };
    const deliver = (records: LookupAddress[]): void => {
      if (lookupOptions.all === true) {
        callback(null, records);
        return;
      }
      const first = records[0];
      if (!first) {
        fail(refuseWebhookAddress(hostname));
        return;
      }
      callback(null, first.address, first.family);
    };

    try {
      const addresses = await resolve(stripHostBrackets(hostname));
      const blocked =
        addresses.length === 0 ||
        (!allowPrivate && addresses.some((address) => isBlockedWebhookHost(address)));
      if (blocked) {
        fail(refuseWebhookAddress(hostname));
        return;
      }
      deliver(
        addresses.map((address) => ({
          address,
          family: isIP(address) === 6 ? 6 : 4,
        })),
      );
    } catch (err: unknown) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new WebhookLookupTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Validate a webhook URL, then resolve a hostname and refuse non-global answers.
 * IP literals are checked without DNS. A lookup that fails or times out is refused.
 */
export async function resolveWebhookUrl(
  url: string,
  options: WebhookResolveOptions = {},
): Promise<void> {
  validateWebhookUrl(url, options);
  if (options.allowPrivate) return;

  const bare = stripHostBrackets(new URL(url).hostname);
  if (isIP(bare) !== 0 || embeddedIpv4(bare) || isBlockedWebhookHost(bare)) return;

  const lookupHost = options.lookup ?? defaultWebhookLookup;
  const timeoutMs = options.lookupTimeoutMs ?? WEBHOOK_LOOKUP_TIMEOUT_MS;
  let addresses: readonly string[];
  try {
    addresses = await withTimeout(lookupHost(bare), timeoutMs);
  } catch (err) {
    if (err instanceof WebhookLookupTimeoutError) throw err;
    throw new Error(`Webhook address lookup failed: ${bare}`);
  }
  if (addresses.length === 0 || addresses.some((address) => isBlockedWebhookHost(address))) {
    throw new Error(`Webhook URL must not point to a loopback or private address: ${bare}`);
  }
}

/**
 * Sanitize a value for use in a template.
 * When `html` is true, HTML-special characters are escaped.
 * @param value - The template variable value.
 * @param html - Whether to apply HTML escaping.
 * @returns The sanitized value.
 */
export function sanitizeTemplateVariable(value: string, html: boolean): string {
  if (!html) {
    return value;
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate an email label name.
 * Rejects control characters, empty or relative path segments, and names
 * longer than 200 characters.
 * @param name - The label name to validate.
 * @returns The trimmed label name.
 */
export function validateLabelName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Label name must not be empty');
  }
  if (trimmed.length > 200) {
    throw new Error('Label name must not exceed 200 characters');
  }
  /* eslint-disable no-control-regex */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in label names
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error('Label name must not contain control characters');
  }
  /* eslint-enable no-control-regex */
  const segments = trimmed.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('Label name must not contain empty or relative path segments');
  }
  return trimmed;
}

/**
 * Validate that an input string does not exceed a maximum length.
 * @param input - The input string to check.
 * @param maxLength - The maximum allowed length.
 * @param fieldName - The field name for the error message.
 */
export function validateInputLength(input: string, maxLength: number, fieldName: string): void {
  if (input.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength} characters`);
  }
}
