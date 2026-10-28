/**
 * Shared body formatting for get_email / get_thread.
 *
 * For AI-friendly `text` / `stripped` output, a tiny text/plain fallback
 * must not hide a materially richer HTML alternative.
 */

import { decodeEntities, isSpace, MAX_DECODE_PASSES, sanitizeAttributes } from './email-html.js';

export type BodyFormat = 'full' | 'text' | 'stripped';

/**
 * Upper bound on HTML handed to the tag walker. The walk runs on the one event loop that
 * also serves every MCP session and the watcher, so a hostile newsletter must not hold it.
 */
export const MAX_HTML_INPUT_CHARS = 2 * 1024 * 1024;
export const HTML_TRUNCATED_NOTE = `\n\n… (HTML part cut at ${MAX_HTML_INPUT_CHARS} characters before conversion)`;

/** Tags whose contents are not text (or can load or run). */
const DROP_WITH_CONTENT = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'textarea',
  'title',
]);

/** Empty tags that load a remote resource or submit a form. */
const DROP_TAG = new Set([
  ...DROP_WITH_CONTENT,
  'link',
  'meta',
  'base',
  'img',
  'video',
  'audio',
  'source',
  'track',
  'form',
]);

interface HtmlTag {
  name: string;
  closing: boolean;
  end: number;
}

function isTagNameChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function readTag(html: string, start: number): HtmlTag | undefined {
  if (html.startsWith('<!--', start)) {
    const end = html.indexOf('-->', start + 4);
    return { name: 'comment', closing: false, end: end === -1 ? html.length : end + 3 };
  }
  let i = start + 1;
  if (html[i] === '!' || html[i] === '?') {
    const end = html.indexOf('>', i);
    if (end === -1) return undefined;
    return { name: '!', closing: false, end: end + 1 };
  }
  let closing = false;
  if (html[i] === '/') {
    closing = true;
    i += 1;
  }
  const nameStart = i;
  while (i < html.length && isTagNameChar(html[i] ?? '')) i += 1;
  if (i === nameStart) return undefined;
  const name = html.slice(nameStart, i).toLowerCase();
  let quote = '';
  while (i < html.length) {
    const ch = html[i] ?? '';
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { name, closing, end: i + 1 };
    }
    i += 1;
  }
  return undefined;
}

/**
 * Lowercases A-Z only, so every index still points at the same character of the source.
 * `toLowerCase()` turns 'İ' into two code units and shifts every later match.
 */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function skipUntilClose(html: string, lower: string, from: number, name: string): number {
  const needle = `</${name}`;
  let i = from;
  while (i < lower.length) {
    const found = lower.indexOf(needle, i);
    if (found === -1) return html.length;
    let j = found + needle.length;
    while (j < html.length && isSpace(html[j] ?? '')) j += 1;
    if (html[j] === '>') return j + 1;
    i = found + needle.length;
  }
  return html.length;
}

function tagText(name: string, closing: boolean): string {
  if (name === 'br' && !closing) return '\n';
  if (name === 'p' && closing) return '\n\n';
  if (name === 'div' && closing) return '\n';
  if (name === 'li' && !closing) return '\n• ';
  return '';
}

function sanitizeTag(raw: string): string {
  const match = /^<(\/?)([A-Za-z0-9]+)([\s\S]*)>$/.exec(raw);
  if (!match || match[1] === '/') return raw;
  return `<${match[2]}${sanitizeAttributes(match[3] ?? '')}>`;
}

function walkHtml(html: string, mode: 'text' | 'html'): string {
  const parts: string[] = [];
  // One lowercase copy per walk: a copy per dropped tag made the walk quadratic in tag count.
  let lower: string | undefined;
  let i = 0;
  while (i < html.length) {
    const next = html.indexOf('<', i);
    if (next === -1) {
      parts.push(html.slice(i));
      break;
    }
    if (next > i) parts.push(html.slice(i, next));
    const tag = readTag(html, next);
    const marker = html[next + 1];
    if (!tag) {
      if (marker && /[A-Za-z/!?]/.test(marker)) break;
      parts.push('<');
      i = next + 1;
    } else if (DROP_WITH_CONTENT.has(tag.name) && !tag.closing) {
      lower ??= asciiLower(html);
      i = skipUntilClose(html, lower, tag.end, tag.name);
    } else if (
      mode === 'html' &&
      (DROP_TAG.has(tag.name) || tag.name === 'comment' || tag.name === '!')
    ) {
      i = tag.end;
    } else if (mode === 'text') {
      parts.push(tagText(tag.name, tag.closing));
      i = tag.end;
    } else {
      parts.push(sanitizeTag(html.slice(next, tag.end)));
      i = tag.end;
    }
  }
  return parts.join('');
}

function capHtml(html: string): { html: string; note: string } {
  if (html.length <= MAX_HTML_INPUT_CHARS) return { html, note: '' };
  return { html: html.slice(0, MAX_HTML_INPUT_CHARS), note: HTML_TRUNCATED_NOTE };
}

/** Strips HTML markup and decodes common entities to produce readable plain text. */
export function stripHtml(html: string): string {
  const capped = capHtml(html);
  let current = capped.html;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const text = walkHtml(decodeEntities(current), 'text')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text === current) break;
    current = text;
  }
  return current + capped.note;
}

/** Removes active and remote-loading markup. Safe tags are left in place. */
function sanitizeEmailHtml(html: string): string {
  const capped = capHtml(html);
  return walkHtml(capped.html, 'html') + capped.note;
}

/** Removes quoted reply chains and signatures from plain text. */
export function stripReplyChain(text: string): string {
  const lines = text.split('\n');
  const stopIdx = lines.findIndex((l) => /^--\s*$/.test(l) || /^_{3,}\s*$/.test(l));
  const relevant = stopIdx === -1 ? lines : lines.slice(0, stopIdx);
  return relevant
    .filter((l) => !l.startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * True when a "plain" part is actually a raw MIME container dump.
 * Must not treat quote separators such as `-----Original Message-----` as MIME.
 */
export function looksLikeRawMime(text: string): boolean {
  const head = text.trimStart();
  if (/^Content-Type\s*:\s*(multipart\/|message\/rfc822)/i.test(head)) return true;
  // Boundary at start-of-line followed by a MIME header — not `--` quote rules.
  return /(?:^|\r?\n)--[A-Za-z0-9'()+_,.=/?-]{1,70}\s*\r?\nContent-(Type|Transfer-Encoding|Disposition)\s*:/i.test(
    text,
  );
}

/**
 * Prefer HTML-derived text when it is materially richer than the plain alternative.
 * "Materially richer" = at least 2× the length and at least 40 extra characters.
 */
export function preferRicherPlain(plain: string | undefined, html: string | undefined): string {
  const htmlText = html ? stripHtml(html) : '';
  const plainText = plain && !looksLikeRawMime(plain) ? plain : '';
  if (!plainText) return htmlText;
  if (!htmlText) return plainText;
  if (htmlText.length >= Math.max(plainText.length * 2, plainText.length + 40)) {
    return htmlText;
  }
  return plainText;
}

export const DEFAULT_BODY_MAX_LENGTH = 20_000;

/**
 * Applies the requested body format and optional character cap.
 *
 * - full:     bodyText, else sanitized bodyHtml (skips raw MIME dumps)
 * - text:     prefers plain; uses richer HTML-derived text when the plain part is a stub
 * - stripped: like text, then removes quoted reply chains and signatures
 */
export function applyBodyFormat(
  bodyText: string | undefined,
  bodyHtml: string | undefined,
  format: BodyFormat,
  maxLength?: number,
): string {
  let body: string;

  if (format === 'full') {
    const plain = bodyText && !looksLikeRawMime(bodyText) ? bodyText : undefined;
    body = plain ?? (bodyHtml !== undefined ? sanitizeEmailHtml(bodyHtml) : '(no content)');
  } else {
    const base = preferRicherPlain(bodyText, bodyHtml) || '(no content)';
    body = format === 'stripped' ? stripReplyChain(base) : base;
  }

  if (maxLength !== undefined && maxLength > 0 && body.length > maxLength) {
    const remaining = body.length - maxLength;
    body = `${body.slice(0, maxLength)}\n\n… (${remaining} more characters — increase maxLength to read the full body)`;
  }

  return body;
}

/**
 * Formats email body and applies `DEFAULT_BODY_MAX_LENGTH` (20,000 chars) when
 * `maxLength` is omitted by the caller, protecting LLM context windows.
 */
export function applyBodyFormatWithDefaultCap(
  bodyText: string | undefined,
  bodyHtml: string | undefined,
  format: BodyFormat,
  maxLength?: number,
): string {
  if (maxLength !== undefined) {
    return applyBodyFormat(bodyText, bodyHtml, format, maxLength);
  }
  const formatted = applyBodyFormat(bodyText, bodyHtml, format);
  if (formatted.length > DEFAULT_BODY_MAX_LENGTH) {
    return `${formatted.slice(0, DEFAULT_BODY_MAX_LENGTH)}\n\n[Truncated at ${DEFAULT_BODY_MAX_LENGTH} characters — pass a larger maxLength for the complete body]`;
  }
  return formatted;
}

export const BASE64_QUANTUM_CHARS = 4;
export const BASE64_QUANTUM_BYTES = 3;

/** RFC 2045 section 6.7: `=` and two hex digits stand for one octet; `=` ending a line is a soft break. */
const QP_ESCAPE = /=(?:\r?\n|([0-9A-Fa-f]{2}))/g;
/** An escape the cut left unfinished: `=` alone, with one hex digit, or with the CR of a soft break. */
const QP_CUT_ESCAPE = /=(?:[0-9A-Fa-f]|\r)?$/;
/** RFC 2045 section 6.8: characters outside the base64 alphabet, line breaks among them, are ignored. */
const NOT_BASE64 = /[^A-Za-z0-9+/=]/g;

function decodeQuotedPrintablePrefix(bytes: Buffer): Buffer {
  // latin1 maps each octet to one character and back, so the escapes are matched octet for octet.
  const text = bytes.toString('latin1').replace(QP_CUT_ESCAPE, '');
  const decoded = text.replace(QP_ESCAPE, (_escape: string, hex?: string) => {
    if (!hex) return '';
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
  return Buffer.from(decoded, 'latin1');
}

function decodeBase64Prefix(bytes: Buffer): Buffer {
  const data = bytes.toString('latin1').replace(NOT_BASE64, '');
  return Buffer.from(data.slice(0, data.length - (data.length % BASE64_QUANTUM_CHARS)), 'base64');
}

function textDecoder(charset: string | undefined): TextDecoder {
  try {
    return new TextDecoder(charset);
  } catch {
    // TextDecoder throws a RangeError for a label it does not know.
    return new TextDecoder();
  }
}

/**
 * Text of the first octets of a MIME part, as a partial FETCH returns them, with the transfer
 * encoding and the charset decoded. What the cut left unfinished at the end (half an escape, part
 * of a base64 group or of a multibyte character) is dropped instead of shown as U+FFFD.
 */
export function decodePartPrefix(bytes: Buffer, encoding?: string, charset?: string): string {
  let octets = bytes;
  if (encoding === 'quoted-printable') octets = decodeQuotedPrintablePrefix(bytes);
  if (encoding === 'base64') octets = decodeBase64Prefix(bytes);
  // A streaming decode holds back a character the cut split; no final flush call may follow.
  return textDecoder(charset).decode(octets, { stream: true });
}
