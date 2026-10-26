/**
 * A server's reply to a failed login can quote what the client sent: the password, the OAuth2
 * access token, or the SASL blob that carried them. Error text from a connection goes through
 * here before it is printed, returned by a tool or logged.
 */

export const REDACTED = '[redacted]';

export const MAX_ERROR_TEXT_LENGTH = 300;

const TRUNCATION_MARKER = '…';

// Matches the OAuth token-endpoint redaction.
const SECRET_SHAPE_MIN_CHARS = 8;

export interface SentCredentials {
  user: string;
  secrets: readonly (string | undefined)[];
}

type Span = [start: number, end: number];

interface SecretShapes {
  /** Cut out wherever they occur. */
  long: RegExp[];
  /** Shorter than SECRET_SHAPE_MIN_CHARS: they match the server's own words, so they are never cut. */
  short: RegExp[];
}

// RFC 6750 b64token.
const BEARER_TOKEN = /\bBearer\s+([\w.~+/-]+=*)/giu;

// Every XOAUTH2 blob is longer than this.
const BASE64_RUN = /[A-Za-z0-9+/]{20,}={0,2}/gu;

const XOAUTH2_BEARER = 'auth=Bearer ';

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function exactPattern(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

function hexDigitsInEitherCase(percentEscape: string): string {
  return percentEscape.replace(/[A-F]/gu, (digit) => `[${digit}${digit.toLowerCase()}]`);
}

/** Encoders write an escape's hex digits in uppercase and an echo can write each in either case. */
function percentEncodedPattern(encoded: string): string {
  return exactPattern(encoded).replace(/%[0-9A-F]{2}/gu, hexDigitsInEitherCase);
}

/** A shape's length is that of the text it matches, not of its pattern, whose escapes are longer. */
function secretShapes(sent: SentCredentials): SecretShapes {
  const lengths = new Map<string, number>();
  sent.secrets
    .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
    .forEach((secret) => {
      [
        secret,
        // AUTH LOGIN
        base64(secret),
        // AUTH PLAIN, without and with an authorization identity
        base64(`\0${sent.user}\0${secret}`),
        base64(`${sent.user}\0${sent.user}\0${secret}`),
        // XOAUTH2
        base64(`user=${sent.user}\u0001auth=Bearer ${secret}\u0001\u0001`),
      ].forEach((shape) => {
        lengths.set(exactPattern(shape), shape.length);
      });
      // encodeURIComponent throws on a lone surrogate; U+FFFD is what UTF-8 put on the wire for it.
      const encoded = encodeURIComponent(secret.replace(/\p{Cs}/gu, '\uFFFD'));
      lengths.set(percentEncodedPattern(encoded), encoded.length);
    });
  const shapes: SecretShapes = { long: [], short: [] };
  lengths.forEach((length, pattern) => {
    shapes[length < SECRET_SHAPE_MIN_CHARS ? 'short' : 'long'].push(new RegExp(pattern, 'u'));
  });
  return shapes;
}

/** A lookahead match is empty, so the scan steps on one character and finds overlapping echoes. */
function echoesOf(text: string, shape: RegExp): Span[] {
  const scan = new RegExp(`(?=(${shape.source}))`, 'gu');
  return Array.from(
    text.matchAll(scan),
    (match): Span => [match.index, match.index + (match[1] ?? '').length],
  );
}

function bearerSpans(text: string): Span[] {
  return [...text.matchAll(BEARER_TOKEN)].map((match): Span => {
    const end = match.index + match[0].length;
    return [end - (match[1] ?? '').length, end];
  });
}

/** Catches an XOAUTH2 blob whose token the caller never saw, such as one nodemailer refreshed. */
function xoauth2BlobSpans(text: string): Span[] {
  return [...text.matchAll(BASE64_RUN)]
    .filter((match) => Buffer.from(match[0], 'base64').toString('latin1').includes(XOAUTH2_BEARER))
    .map((match): Span => [match.index, match.index + match[0].length]);
}

function mergeSpans(spans: Span[]): Span[] {
  return [...spans]
    .sort((a, b) => a[0] - b[0])
    .reduce<Span[]>((merged, [start, end]) => {
      const last = merged.at(-1);
      if (last && start <= last[1]) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
      return merged;
    }, []);
}

function capped(text: string): string {
  if (text.length <= MAX_ERROR_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_ERROR_TEXT_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function insideAMarker([start, end]: Span, markers: readonly number[]): boolean {
  return markers.some((at) => at <= start && end <= at + REDACTED.length);
}

/**
 * Text that holds a short shape anywhere is withheld whole, and so is text whose pieces around a
 * cut spell a secret with the marker between (a secret `AA[redacted]ZZ` around a cut token).
 * Redacts before capping: a cut through a secret would leave a prefix no shape matches.
 */
export function redactSentCredentials(text: string, sent: SentCredentials): string {
  const shapes = secretShapes(sent);
  if (shapes.short.some((shape) => shape.test(text))) return REDACTED;
  const spans = mergeSpans([
    ...shapes.long.flatMap((shape) => echoesOf(text, shape)),
    ...bearerSpans(text),
    ...xoauth2BlobSpans(text),
  ]);
  // Spans index the original text, so one marker cannot form or split another match.
  let redacted = '';
  let cursor = 0;
  const markers: number[] = [];
  spans.forEach(([start, end]) => {
    redacted += text.slice(cursor, start);
    markers.push(redacted.length);
    redacted += REDACTED;
    cursor = end;
  });
  redacted += text.slice(cursor);
  const spelled = [...shapes.long, ...shapes.short].flatMap((shape) => echoesOf(redacted, shape));
  if (spelled.some((echo) => !insideAMarker(echo, markers))) return REDACTED;
  return capped(redacted);
}

/**
 * nodemailer's EAUTH carries the server line in `message` and `response`, imapflow's in
 * `response` and `responseText`; callers print, return, audit or queue `message`. `response`,
 * `responseText` and `cause` stay off on purpose.
 */
export function redactedError(err: unknown, sent: SentCredentials): Error {
  if (!(err instanceof Error)) return new Error(redactSentCredentials(String(err), sent));
  const { code, responseCode, command } = err as Error & {
    code?: string;
    responseCode?: number;
    command?: string;
  };
  return Object.assign(new Error(redactSentCredentials(err.message, sent)), {
    code,
    responseCode,
    command,
  });
}
