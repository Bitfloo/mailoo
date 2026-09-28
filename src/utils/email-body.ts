/**
 * Shared body formatting for get_email / get_thread.
 *
 * For AI-friendly `text` / `stripped` output, a tiny text/plain fallback
 * must not hide a materially richer HTML alternative.
 */

export type BodyFormat = 'full' | 'text' | 'stripped';

/**
 * Each pass decodes one entity layer and then strips tags that layer exposed.
 * Three passes drop a tag written as `&amp;amp;lt;script&amp;amp;gt;`; two leave
 * `&lt;script&gt;`. Further layers stay as text so decoding has a ceiling.
 */
const MAX_DECODE_PASSES = 3;

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

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

function isSpace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f';
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

function skipUntilClose(html: string, from: number, name: string): number {
  const needle = `</${name}`;
  const lower = html.toLowerCase();
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

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return '';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

function tagText(name: string, closing: boolean): string {
  if (name === 'br' && !closing) return '\n';
  if (name === 'p' && closing) return '\n\n';
  if (name === 'div' && closing) return '\n';
  if (name === 'li' && !closing) return '\n• ';
  return '';
}

function sanitizeTag(raw: string): string {
  if (!/^<\/?[^\s>]+\s/.test(raw)) return raw;
  const match = /^<(\/?)([A-Za-z0-9]+)([\s\S]*)>$/.exec(raw);
  if (!match || match[1] === '/') return raw;
  const attrs = match[3]
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /\s+(?:href|src|action|poster|background)\s*=\s*(?:"(?!https?:|mailto:)[^"]*"|'(?!https?:|mailto:)[^']*'|(?!https?:|mailto:)[^\s>]+)/gi,
      '',
    );
  return `<${match[2]}${attrs}>`;
}

function walkHtml(html: string, mode: 'text' | 'html'): string {
  const parts: string[] = [];
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
      i = skipUntilClose(html, tag.end, tag.name);
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

/** Strips HTML markup and decodes common entities to produce readable plain text. */
export function stripHtml(html: string): string {
  let current = html;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const text = walkHtml(decodeEntities(current), 'text')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text === current) return text;
    current = text;
  }
  return current;
}

/** Removes active and remote-loading markup. Safe tags are left in place. */
function sanitizeEmailHtml(html: string): string {
  return walkHtml(html, 'html');
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
