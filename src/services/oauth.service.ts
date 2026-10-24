/**
 * OAuth2 token management service.
 *
 * Handles token refresh and caching for Google and Microsoft OAuth2/XOAUTH2.
 * Uses native fetch (Node 22+) — no external HTTP dependencies.
 */

import type { OAuth2Config } from '../types/index.js';

// ---------------------------------------------------------------------------
// Provider endpoint configs
// ---------------------------------------------------------------------------

interface ProviderEndpoints {
  tokenUrl: string;
  authUrl: string;
  scopes: string[];
}

const PROVIDER_ENDPOINTS: Record<string, ProviderEndpoints> = {
  google: {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: ['https://mail.google.com/'],
  },
  microsoft: {
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
    ],
  },
};

/** 5-minute safety buffer before token expiry */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** A token endpoint that stops answering would otherwise stall every IMAP or SMTP connect behind it. */
export const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** RFC 6749 §5.2 error codes are a few words; the cap bounds what a custom endpoint can make us repeat. */
export const TOKEN_ERROR_CODE_MAX_CHARS = 64;

export const TOKEN_ERROR_DESCRIPTION_MAX_CHARS = 200;

/** A real error answer is a few hundred bytes; a larger body is not parsed at all. */
export const TOKEN_ERROR_BODY_MAX_CHARS = 4096;

/** The RFC 6749 §5.2 error field charset (%x20-21 / %x23-5B / %x5D-7E); anything else is dropped. */
const OUTSIDE_ERROR_CHARSET = /[^\x20\x21\x23-\x5B\x5D-\x7E]/g;

/**
 * Shorter than this, a secret's shape matches letters and words of the provider's own prose, and
 * cutting each match out garbles the field. A field holding such a shape is dropped instead. It is
 * also the length of the pieces of a secret no refusal detail may hold.
 */
export const SECRET_SHAPE_MIN_CHARS = 8;

const REDACTED = '[redacted]';

const SENT_SECRET_FIELDS = ['client_secret', 'refresh_token', 'code'] as const;

interface SecretShapes {
  /** Cut out of a field wherever they occur. */
  long: RegExp[];
  /** Shorter than SECRET_SHAPE_MIN_CHARS: a field holding one is dropped whole. */
  short: RegExp[];
}

function dropOutsideCharset(value: string): string {
  return value.replace(OUTSIDE_ERROR_CHARSET, '');
}

function exactPattern(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function hexDigitsInEitherCase(escaped: string): string {
  return escaped.replace(/[A-F]/g, (digit) => `[${digit}${digit.toLowerCase()}]`);
}

function encodedPattern(encoded: string): string {
  return exactPattern(encoded).replace(/%[0-9A-F]{2}/g, hexDigitsInEitherCase);
}

/**
 * An endpoint can quote back what the request sent, as given, form-encoded the way the body
 * carried it, or URL-encoded. The given form also counts with the charset-dropped characters
 * gone, since the filter turns an escaped or broken-up echo back into that; the encoded forms
 * hold none. Encoders write an escape's hex digits in uppercase and an echo can write them in
 * either case, so those digits match either way; everything else matches exactly. A shape's
 * length is that of the text it matches, not of its pattern, whose escapes are longer.
 */
function sentSecretShapes(sent: URLSearchParams): SecretShapes {
  const lengths = new Map<string, number>();
  SENT_SECRET_FIELDS.forEach((field) => {
    // Read back from the form, so no lone surrogate is left for encodeURIComponent to throw on.
    const secret = sent.get(field);
    if (!secret) return;
    const filtered = dropOutsideCharset(secret);
    const formEncoded = new URLSearchParams({ x: secret }).toString().slice(2);
    const urlEncoded = encodeURIComponent(secret);
    lengths.set(exactPattern(secret), secret.length);
    lengths.set(exactPattern(filtered), filtered.length);
    lengths.set(encodedPattern(formEncoded), formEncoded.length);
    lengths.set(encodedPattern(urlEncoded), urlEncoded.length);
  });
  // A secret made only of dropped characters has an empty filtered shape, which matches anywhere.
  lengths.delete('');
  const shapes: SecretShapes = { long: [], short: [] };
  lengths.forEach((length, pattern) => {
    const kind = length < SECRET_SHAPE_MIN_CHARS ? 'short' : 'long';
    shapes[kind].push(new RegExp(pattern));
  });
  return shapes;
}

/** A lookahead match is empty, so the scan steps on one character and finds overlapping echoes. */
function echoesOf(text: string, secret: RegExp): number[][] {
  const scan = new RegExp(`(?=(${secret.source}))`, 'g');
  return Array.from(text.matchAll(scan), (match) => [match.index, match.index + match[1].length]);
}

/**
 * Echoes that overlap or touch, of one secret or of several, are cut out as one, so joining the
 * text around the cuts with the marker leaves no piece of a secret.
 */
function mergedCuts(echoes: number[][]): number[][] {
  const cuts: number[][] = [];
  [...echoes]
    .sort(([a], [b]) => a - b)
    .forEach(([start, end]) => {
      const last = cuts.at(-1);
      if (last && start <= last[1]) {
        last[1] = Math.max(last[1], end);
      } else {
        cuts.push([start, end]);
      }
    });
  return cuts;
}

/** The charset-filtered text around the cuts, one marker per cut, and where each marker starts. */
function textAroundCuts(value: string, cuts: number[][]): { text: string; markers: number[] } {
  let text = '';
  let from = 0;
  const markers: number[] = [];
  cuts.forEach(([start, end]) => {
    text += dropOutsideCharset(value.slice(from, start));
    markers.push(text.length);
    text += REDACTED;
    from = end;
  });
  return { text: text + dropOutsideCharset(value.slice(from)), markers };
}

function insideAMarker([start, end]: number[], markers: readonly number[]): boolean {
  return markers.some((at) => at <= start && end <= at + REDACTED.length);
}

/**
 * Echoes are found in the raw text and in its charset-filtered view in one pass, the filtered ones
 * mapped back to raw offsets, so a secret broken by a dropped character around another secret is
 * cut whole. The marker goes in once, after every echo is known, so a secret made of marker letters
 * never matches inside one. The text either side of a cut can still spell a secret with the marker
 * between (a client secret `AA[redacted]ZZ` around a cut grant): a field where any secret appears
 * outside a single marker is dropped, and so is one that holds a short shape anywhere. All of this
 * runs before the cut, so no piece survives it.
 */
function cleanErrorField(value: unknown, maxChars: number, shapes: SecretShapes): string {
  if (typeof value !== 'string') return '';
  // UTF-16 units, as match offsets count them: the charset drops each half of a surrogate pair.
  const keptAt = Array.from({ length: value.length }, (_, at) => at).filter(
    (at) => dropOutsideCharset(value[at]) !== '',
  );
  const filtered = keptAt.map((at) => value[at]).join('');
  if (shapes.short.some((shape) => shape.test(value) || shape.test(filtered))) return '';
  const echoes = shapes.long.flatMap((secret) => [
    ...echoesOf(value, secret),
    ...echoesOf(filtered, secret).map(([start, end]) => [keptAt[start], keptAt[end - 1] + 1]),
  ]);
  const { text, markers } = textAroundCuts(value, mergedCuts(echoes));
  const spelled = [...shapes.long, ...shapes.short].flatMap((secret) => echoesOf(text, secret));
  if (spelled.some((echo) => !insideAMarker(echo, markers))) return '';
  return text.slice(0, maxChars).trim();
}

/** Echoes are escaped once, or twice behind a proxy; the bound leaves room for more. */
const PERCENT_DECODE_MAX_ROUNDS = 4;

const PERCENT_ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/** Bytes that are not UTF-8 decode to U+FFFD, so a malformed escape never throws. */
function decodedEscapes(run: string): string {
  return Buffer.from(run.replaceAll('%', ''), 'hex').toString('utf8');
}

/** An escape that is not two hex digits stays as written. */
function percentDecoded(text: string): string {
  let decoded = text;
  for (let round = 0; round < PERCENT_DECODE_MAX_ROUNDS; round += 1) {
    const next = decoded.replace(PERCENT_ESCAPE_RUN, decodedEscapes);
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}

/**
 * The ASCII letters and digits of a text once decoded, in lowercase: a form-encoded `+`, a space,
 * punctuation or a changed case inside an echo no longer hide what it spells.
 */
function skeleton(text: string): string {
  return percentDecoded(text)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Every piece of a secret no field may hold: its 8-character windows, or all of a shorter one. */
function piecesOf(secret: string): string[] {
  if (!secret) return [];
  const width = Math.min(secret.length, SECRET_SHAPE_MIN_CHARS);
  const starts = secret.length - width + 1;
  return Array.from({ length: starts }, (_, at) => secret.slice(at, at + width));
}

/**
 * The last check on what the message would carry, after the whole echoes are cut: a piece of a
 * sent secret split across the two fields, escaped more than once, cased or spaced differently.
 * The fields are read as one text, the code first, so a secret split between them is found. Each
 * cut is a break in that text, so the marker's letters and the words either side never spell
 * anything. A secret broken by letters, digits or the marker itself every few characters is not
 * looked for.
 */
function holdsPieceOfSentSecret(fields: readonly string[], sent: URLSearchParams): boolean {
  const text = fields.map((field) => field.split(REDACTED).map(skeleton).join(' ')).join('');
  const secrets = SENT_SECRET_FIELDS.map((field) => skeleton(sent.get(field) ?? ''));
  return secrets.flatMap(piecesOf).some((piece) => text.includes(piece));
}

/**
 * The part of a refused answer the error message may carry: only RFC 6749 `error` and
 * `error_description`, with the secrets the request sent replaced, and nothing at all when a piece
 * of one is left. Messages reach tool results, logs and the audit log, and a custom endpoint or a
 * proxy in front of one can put tokens or a whole HTML page in the body, or quote the request back
 * inside those two fields.
 */
function refusalDetail(body: string, sent: URLSearchParams): string {
  if (body.length > TOKEN_ERROR_BODY_MAX_CHARS) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  if (typeof parsed !== 'object' || parsed === null) return '';
  const fields = parsed as { error?: unknown; error_description?: unknown };
  const shapes = sentSecretShapes(sent);
  const code = cleanErrorField(fields.error, TOKEN_ERROR_CODE_MAX_CHARS, shapes);
  if (!code) return '';
  const description = cleanErrorField(
    fields.error_description,
    TOKEN_ERROR_DESCRIPTION_MAX_CHARS,
    shapes,
  );
  if (holdsPieceOfSentSecret([code, description], sent)) return '';
  return description ? `: ${code}: ${description}` : `: ${code}`;
}

/**
 * Redirects are not followed: a 307 or 308 would send the form, client secret included, on to
 * whatever the Location names, so a 3xx is refused like any other status. The timeout also covers
 * the body: an endpoint can send its headers and then stall.
 */
async function sendTokenRequest(
  tokenUrl: string,
  body: URLSearchParams,
  action: string,
): Promise<{ response: Response; text: string }> {
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    return { response, text: await response.text() };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`OAuth2 ${action} timed out after ${TOKEN_REQUEST_TIMEOUT_MS / 1000}s`, {
        cause: err,
      });
    }
    // Not chained: fetch errors quote the token URL, whose userinfo or query can hold a credential.
    throw new Error(`OAuth2 ${action} failed: the token endpoint could not be reached`);
  }
}

async function postTokenRequest<T>(
  tokenUrl: string,
  body: URLSearchParams,
  action: string,
): Promise<T> {
  const { response, text } = await sendTokenRequest(tokenUrl, body, action);
  if (!response.ok) {
    throw new Error(`OAuth2 ${action} failed (${response.status})${refusalDetail(text, body)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // Not chained: a SyntaxError message quotes the start of the body, which can hold a token.
    throw new Error(`OAuth2 ${action} failed: the token endpoint did not return JSON`);
  }
}

export default class OAuthService {
  /**
   * Refreshes in flight, keyed by refresh token. When a token expires, the IMAP pool, the SMTP
   * transport and the watcher all ask at once, each through its own service instance; without
   * this every one of them POSTs the same refresh token and providers throttle the burst.
   */
  private static readonly pendingRefresh = new Map<
    string,
    Promise<{ accessToken: string; tokenExpiry: number }>
  >();

  /**
   * Get a valid access token, refreshing if expired.
   */
  // eslint-disable-next-line class-methods-use-this
  async getAccessToken(oauth2: OAuth2Config): Promise<string> {
    if (!OAuthService.isTokenExpired(oauth2) && oauth2.accessToken) {
      return oauth2.accessToken;
    }

    const { refreshToken } = oauth2;
    let pending = OAuthService.pendingRefresh.get(refreshToken);
    if (!pending) {
      pending = OAuthService.refreshAccessToken(oauth2)
        .then((result) => ({
          accessToken: result.accessToken,
          tokenExpiry: Date.now() + result.expiresIn * 1000,
        }))
        .finally(() => {
          OAuthService.pendingRefresh.delete(refreshToken);
        });
      OAuthService.pendingRefresh.set(refreshToken, pending);
    }

    // Cache on the config object (in-memory only)
    const token = await pending;
    Object.assign(oauth2, token);

    return token.accessToken;
  }

  /**
   * Check if the cached access token is expired or missing.
   */
  static isTokenExpired(oauth2: OAuth2Config): boolean {
    if (!oauth2.accessToken || !oauth2.tokenExpiry) return true;
    return Date.now() >= oauth2.tokenExpiry - TOKEN_EXPIRY_BUFFER_MS;
  }

  /**
   * Exchange refresh token for a new access token.
   */
  static async refreshAccessToken(
    oauth2: OAuth2Config,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: oauth2.clientId,
      client_secret: oauth2.clientSecret,
      refresh_token: oauth2.refreshToken,
    });

    const data = await postTokenRequest<{ access_token: string; expires_in: number }>(
      endpoints.tokenUrl,
      body,
      'token refresh',
    );

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    };
  }

  /**
   * Get provider endpoints for token exchange and authorization.
   */
  static getProviderEndpoints(oauth2: OAuth2Config): ProviderEndpoints {
    if (oauth2.provider === 'custom') {
      if (!oauth2.tokenUrl || !oauth2.authUrl) {
        throw new Error('Custom OAuth2 provider requires tokenUrl and authUrl');
      }
      return {
        tokenUrl: oauth2.tokenUrl,
        authUrl: oauth2.authUrl,
        scopes: oauth2.scopes ?? [],
      };
    }

    const endpoints = PROVIDER_ENDPOINTS[oauth2.provider];
    if (!endpoints) {
      throw new Error(`Unknown OAuth2 provider: ${oauth2.provider}`);
    }
    return endpoints;
  }

  /**
   * Generate an OAuth2 authorization URL for the CLI setup wizard.
   */
  static generateAuthUrl(oauth2: OAuth2Config, redirectUri: string): string {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);
    const params = new URLSearchParams({
      client_id: oauth2.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: endpoints.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });
    return `${endpoints.authUrl}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens (initial setup).
   */
  static async exchangeCode(
    oauth2: OAuth2Config,
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: oauth2.clientId,
      client_secret: oauth2.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const data = await postTokenRequest<{
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }>(endpoints.tokenUrl, body, 'code exchange');

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }
}
