/**
 * Decode email HTML and drop event-handler attributes and unsafe URLs.
 */

/**
 * Each pass decodes one entity layer and then strips tags that layer exposed.
 * Three passes drop a tag written as `&amp;amp;lt;script&amp;amp;gt;`; two leave
 * `&lt;script&gt;`. Further layers stay as text so decoding has a ceiling.
 */
export const MAX_DECODE_PASSES = 3;

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

export function isSpace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f';
}

export function decodeEntities(input: string): string {
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

const EVENT_HANDLER_NAME = /^on[a-z]+$/i;
const STYLE_NAME = /^style$/i;
const URL_ATTR_NAME = /^(?:href|src|action|formaction|poster|background)$/i;
const SAFE_URL_VALUE = /^(?:https?:|mailto:)/i;

/**
 * HTML consumes a numeric character reference without a semicolon
 * (`on&#99lick` is `onclick`). Named references stay semicolon-terminated
 * so `&amp` inside a word is left alone.
 */
function decodeNumericReferences(input: string): string {
  return input.replace(/&#(x[0-9a-f]+|\d+);?/gi, (_entity, body: string) => {
    const hex = body.startsWith('x') || body.startsWith('X');
    const digits = hex ? body.slice(1) : body;
    const code = Number.parseInt(digits, hex ? 16 : 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return '';
    // fromCodePoint throws on a lone surrogate.
    if (code >= 0xd800 && code <= 0xdfff) return '';
    return String.fromCodePoint(code);
  });
}

function decodeBounded(input: string): string {
  let current = input;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next = decodeNumericReferences(decodeEntities(current));
    if (next === current) return current;
    current = next;
  }
  return current;
}

function dropAttribute(name: string, value: string | undefined): boolean {
  const decodedName = decodeBounded(name);
  if (EVENT_HANDLER_NAME.test(decodedName) || STYLE_NAME.test(decodedName)) return true;
  if (value === undefined) return false;
  return URL_ATTR_NAME.test(decodedName) && !SAFE_URL_VALUE.test(decodeBounded(value).trim());
}

interface ScannedAttribute {
  end: number;
  kept: string;
  drop: boolean;
}

function scanAttribute(input: string, start: number): ScannedAttribute {
  let i = start;
  while (i < input.length && isSpace(input[i] ?? '')) i += 1;
  const nameStart = i;
  while (i < input.length) {
    const ch = input[i] ?? '';
    if (isSpace(ch) || ch === '=' || ch === '/' || ch === '"' || ch === "'") break;
    i += 1;
  }
  const name = input.slice(nameStart, i);
  if (!name) {
    const end = Math.min(input.length, i + 1);
    const separator = (input[i] ?? '') === '/';
    return { end, kept: separator ? '' : input.slice(start, end), drop: false };
  }
  const afterName = i;
  while (i < input.length && isSpace(input[i] ?? '')) i += 1;
  if ((input[i] ?? '') !== '=') {
    return {
      end: afterName,
      kept: input.slice(start, afterName),
      drop: dropAttribute(name, undefined),
    };
  }
  i += 1;
  while (i < input.length && isSpace(input[i] ?? '')) i += 1;
  const quote = input[i];
  let value = '';
  if (quote === '"' || quote === "'") {
    i += 1;
    const valueStart = i;
    while (i < input.length && input[i] !== quote) i += 1;
    value = input.slice(valueStart, i);
    if (i < input.length) i += 1;
  } else {
    const valueStart = i;
    while (i < input.length && !isSpace(input[i] ?? '')) i += 1;
    value = input.slice(valueStart, i);
  }
  return { end: i, kept: input.slice(start, i), drop: dropAttribute(name, value) };
}

/**
 * Event-handler attributes may sit directly against the previous quoted value
 * (`class="x"onerror=alert(1)`). A whitespace-only strip leaves that handler in place.
 * Attribute values are copied whole, so the letters "on" inside them stay.
 */
export function sanitizeAttributes(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const scanned = scanAttribute(source, i);
    if (scanned.end <= i) break;
    if (!scanned.drop && scanned.kept) {
      const needsSpace = !isSpace(scanned.kept[0] ?? '') && !isSpace(out.at(-1) ?? '');
      out += needsSpace ? ` ${scanned.kept}` : scanned.kept;
    }
    i = scanned.end;
  }
  return out;
}
