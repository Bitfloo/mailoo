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

const REDACTED = '[redacted]';

const SENT_SECRET_FIELDS = ['client_secret', 'refresh_token', 'code'] as const;

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
 * either case, so those digits match either way; everything else matches exactly. Longest
 * first, so a secret that contains another is replaced whole.
 */
function sentSecretShapes(sent: URLSearchParams): RegExp[] {
  const lengths = new Map<string, number>();
  SENT_SECRET_FIELDS.forEach((field) => {
    // Read back from the form, so no lone surrogate is left for encodeURIComponent to throw on.
    const secret = sent.get(field);
    if (!secret) return;
    [secret, dropOutsideCharset(secret)].forEach((given) => {
      lengths.set(exactPattern(given), given.length);
    });
    [new URLSearchParams({ x: secret }).toString().slice(2), encodeURIComponent(secret)].forEach(
      (encoded) => {
        lengths.set(encodedPattern(encoded), encoded.length);
      },
    );
  });
  lengths.delete('');
  return [...lengths].sort(([, a], [, b]) => b - a).map(([pattern]) => new RegExp(pattern, 'g'));
}

function redact(text: string, secrets: readonly RegExp[]): string {
  return secrets.reduce((kept, secret) => kept.replace(secret, REDACTED), text);
}

/** Redacted before and after the charset filter, and both before the cut, so no piece survives. */
function cleanErrorField(value: unknown, maxChars: number, secrets: readonly RegExp[]): string {
  if (typeof value !== 'string') return '';
  return redact(dropOutsideCharset(redact(value, secrets)), secrets)
    .slice(0, maxChars)
    .trim();
}

/**
 * The part of a refused answer the error message may carry: only RFC 6749 `error` and
 * `error_description`, with the secrets the request sent replaced. Messages reach tool results,
 * logs and the audit log, and a custom endpoint or a proxy in front of one can put tokens or a
 * whole HTML page in the body, or quote the request back inside those two fields.
 */
function refusalDetail(body: string, secrets: readonly RegExp[]): string {
  if (body.length > TOKEN_ERROR_BODY_MAX_CHARS) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  if (typeof parsed !== 'object' || parsed === null) return '';
  const fields = parsed as { error?: unknown; error_description?: unknown };
  const code = cleanErrorField(fields.error, TOKEN_ERROR_CODE_MAX_CHARS, secrets);
  if (!code) return '';
  const description = cleanErrorField(
    fields.error_description,
    TOKEN_ERROR_DESCRIPTION_MAX_CHARS,
    secrets,
  );
  return description ? `: ${code}: ${description}` : `: ${code}`;
}

/** The timeout also covers the body: an endpoint can send its headers and then stall. */
async function postTokenRequest<T>(
  tokenUrl: string,
  body: URLSearchParams,
  action: string,
): Promise<T> {
  try {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `OAuth2 ${action} failed (${response.status})${refusalDetail(text, sentSecretShapes(body))}`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      // Not chained: a SyntaxError message quotes the start of the body, which can hold a token.
      throw new Error(`OAuth2 ${action} failed: the token endpoint did not return JSON`);
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`OAuth2 ${action} timed out after ${TOKEN_REQUEST_TIMEOUT_MS / 1000}s`, {
        cause: err,
      });
    }
    throw err;
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
