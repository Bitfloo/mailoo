/** Input validation and sanitization utilities. */

import { z } from 'zod';

/**
 * HTML5 email production — no regex lookaheads.
 * Zod's default `.email()` emits a lookahead pattern that llama.cpp GBNF cannot compile.
 */
export const recipientEmail = z.string().regex(z.regexes.html5Email);

/**
 * Characters that change IMAP command structure when a mailbox name is one token:
 * quoted-string (`"`, `\`), literal (`{`, `}`), and list (`(`, `)`).
 * `*` and `%` are wildcards and are rejected separately. `]` stays allowed
 * because Gmail paths such as `[Gmail]/All Mail` contain it.
 */
const MAILBOX_SPECIAL = /["\\{}()]/;

/** IMAP UID is an nz-number: 1 through 2^32-1, with no leading zeros (RFC 9051). */
const MAX_MESSAGE_UID = 4_294_967_295;

/**
 * Validate and sanitize an IMAP mailbox name.
 * Rejects empty names, control characters, IMAP wildcards (`*`, `%`),
 * and characters that change quoted-string, literal, or list syntax.
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
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in mailbox names
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new Error('Mailbox name must not contain control characters');
  }
  /* eslint-enable no-control-regex */
  if (MAILBOX_SPECIAL.test(trimmed)) {
    throw new Error('Mailbox name must not contain IMAP special characters');
  }
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
 * Validate a webhook URL.
 * Ensures the URL uses http(s) and does not point to a private or loopback address.
 * @param url - The webhook URL to validate.
 */
export function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Webhook URL must use http or https protocol, got ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // new URL('https://[::1]') stores hostname as '[::1]'
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare === '::1' || bare === '0.0.0.0') {
    throw new Error(`Webhook URL must not point to a loopback or private address: ${bare}`);
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      throw new Error(`Webhook URL must not point to a loopback or private address: ${bare}`);
    }
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
