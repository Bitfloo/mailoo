/**
 * A server's reply to a failed login can quote what the client sent: the password, the OAuth2
 * access token, or the SASL blob that carried them. Error text from a connection goes through
 * here before it is printed, returned by a tool or logged.
 */

export const REDACTED = '[redacted]';

export const MAX_ERROR_TEXT_LENGTH = 300;

const TRUNCATION_MARKER = '…';

/** Shorter needles are redacted only as a whole word, so a one-letter password keeps the reply readable. */
export const MIN_SUBSTRING_NEEDLE_LENGTH = 8;

export interface SentCredentials {
  user: string;
  secrets: readonly (string | undefined)[];
}

type Span = [start: number, end: number];

const WORD_CHAR = /[\p{L}\p{N}]/u;

// RFC 6750 b64token.
const BEARER_TOKEN = /\bBearer\s+([\w.~+/-]+=*)/giu;

// Every XOAUTH2 blob is longer than this.
const BASE64_RUN = /[A-Za-z0-9+/]{20,}={0,2}/gu;

const XOAUTH2_BEARER = /auth=Bearer /iu;

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function needlesFor(secret: string, user: string): string[] {
  const percentEncoded = encodeURIComponent(secret);
  return [
    secret,
    // AUTH LOGIN
    base64(secret),
    // AUTH PLAIN, without and with an authorization identity
    base64(`\0${user}\0${secret}`),
    base64(`${user}\0${user}\0${secret}`),
    // XOAUTH2
    base64(`user=${user}\u0001auth=Bearer ${secret}\u0001\u0001`),
    percentEncoded,
    percentEncoded.replace(/%[0-9A-F]{2}/gu, (hex) => hex.toLowerCase()),
  ];
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char);
}

function needleSpans(text: string, needle: string): Span[] {
  const spans: Span[] = [];
  const wholeWordOnly = needle.length < MIN_SUBSTRING_NEEDLE_LENGTH;
  let start = text.indexOf(needle);
  while (start !== -1) {
    const end = start + needle.length;
    if (!wholeWordOnly || (!isWordChar(text[start - 1]) && !isWordChar(text[end]))) {
      spans.push([start, end]);
    }
    start = text.indexOf(needle, start + 1);
  }
  return spans;
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
    .filter((match) => XOAUTH2_BEARER.test(Buffer.from(match[0], 'base64').toString('latin1')))
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

/** Redacts before capping: a cut through a secret would leave a prefix no needle matches. */
export function redactSentCredentials(text: string, sent: SentCredentials): string {
  const needles = sent.secrets
    .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
    .flatMap((secret) => needlesFor(secret, sent.user));
  const spans = mergeSpans([
    ...needles.flatMap((needle) => needleSpans(text, needle)),
    ...bearerSpans(text),
    ...xoauth2BlobSpans(text),
  ]);
  // Spans index the original text, so one marker cannot form or split another match.
  let redacted = '';
  let cursor = 0;
  spans.forEach(([start, end]) => {
    redacted += text.slice(cursor, start) + REDACTED;
    cursor = end;
  });
  return capped(redacted + text.slice(cursor));
}
