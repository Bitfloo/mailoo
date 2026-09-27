/** Input validation and sanitization utilities. */

import { lookup } from 'node:dns/promises';
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
 * One IMAP UID (RFC 9051 nz-number, 1 through 2^32-1).
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
BLOCKED_WEBHOOK_ADDRESSES.addAddress('100.100.100.200', 'ipv4');
BLOCKED_WEBHOOK_ADDRESSES.addAddress('::', 'ipv6');
BLOCKED_WEBHOOK_ADDRESSES.addAddress('::1', 'ipv6');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('fc00::', 7, 'ipv6');
BLOCKED_WEBHOOK_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');

const METADATA_WEBHOOK_HOSTS = new Set(['metadata.google.internal', 'metadata.goog']);

/** How long a webhook hostname lookup may take before it is refused. */
export const WEBHOOK_LOOKUP_TIMEOUT_MS = 2_000;

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

/** `::ffff:7f00:1` and `::ffff:127.0.0.1` both carry an IPv4 address. */
function embeddedIpv4(host: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(host);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  const octet = (value: number): string => `${Math.floor(value / 256)}.${value % 256}`;
  return `${octet(high)}.${octet(low)}`;
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Webhook address lookup timed out'));
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
    if (err instanceof Error && err.message === 'Webhook address lookup timed out') throw err;
    throw new Error(`Webhook URL must not point to a loopback or private address: ${bare}`);
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
 * Metacharacters that are not a single IMAP flag atom or one mailbox segment.
 * Space and `/` stay allowed: Gmail labels use spaces, nested labels use `/`.
 */
const LABEL_SPECIAL = /[\]"\\{}()*%]/;

/**
 * Validate an email label name.
 * Rejects control characters, flag and mailbox metacharacters, relative path
 * segments, and names longer than 200 characters.
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
  if (LABEL_SPECIAL.test(trimmed)) {
    throw new Error('Label name must not contain IMAP special characters');
  }
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
