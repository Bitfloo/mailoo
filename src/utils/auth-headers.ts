/**
 * Parse sender-authentication headers for read-only triage.
 * Unfolds RFC 5322 folded lines and preserves repeated Authentication-Results.
 */

export type AuthResultCode =
  | 'pass'
  | 'fail'
  | 'softfail'
  | 'neutral'
  | 'none'
  | 'temperror'
  | 'permerror'
  | 'unknown';

export interface DkimResult {
  result: AuthResultCode;
  domain?: string;
}

export interface SenderAuthSignals {
  fromDomain?: string;
  replyToDomain?: string;
  returnPathDomain?: string;
  spf?: AuthResultCode;
  dkim: DkimResult[];
  dmarc?: AuthResultCode;
  hasListUnsubscribe: boolean;
  hasListUnsubscribePost: boolean;
}

const AUTH_CODES = new Set<string>([
  'pass',
  'fail',
  'softfail',
  'neutral',
  'none',
  'temperror',
  'permerror',
]);

export function unfoldHeaders(raw: string): string {
  return raw.replace(/\r?\n[ \t]+/g, ' ');
}

function headerValues(unfolded: string, name: string): string[] {
  const prefix = `${name.toLowerCase()}:`;
  return unfolded
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.toLowerCase().startsWith(prefix))
    .map((line) => line.slice(line.indexOf(':') + 1).trim());
}

function domainFromAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const angle = /<([^>]+)>/.exec(value);
  const addr = (angle ? angle[1] : value).trim().replace(/^mailto:/i, '');
  const at = addr.lastIndexOf('@');
  if (at < 0) return undefined;
  return addr
    .slice(at + 1)
    .replace(/[>;].*$/, '')
    .toLowerCase();
}

function parseAuthCode(raw: string | undefined): AuthResultCode | undefined {
  if (!raw) return undefined;
  const code = raw.toLowerCase();
  if (AUTH_CODES.has(code)) return code as AuthResultCode;
  return 'unknown';
}

function parseMethod(resultsBlock: string, method: 'spf' | 'dmarc'): AuthResultCode | undefined {
  const re = new RegExp(
    `(?:^|[\\s;])${method}=(pass|fail|softfail|neutral|none|temperror|permerror)`,
    'i',
  );
  const match = re.exec(resultsBlock);
  return parseAuthCode(match?.[1]);
}

function parseDkim(resultsBlock: string): DkimResult[] {
  const out: DkimResult[] = [];
  const re = /(?:^|[\s;])dkim=(pass|fail|softfail|neutral|none|temperror|permerror)([^;]*)/gi;
  let match = re.exec(resultsBlock);
  while (match) {
    const domain = /header\.d=([^\s;]+)/i.exec(match[2])?.[1] ?? /d=([^\s;]+)/i.exec(match[2])?.[1];
    out.push({ result: parseAuthCode(match[1]) ?? 'unknown', domain: domain?.toLowerCase() });
    match = re.exec(resultsBlock);
  }
  return out;
}

function parseDkimSignatureDomains(unfolded: string): string[] {
  return headerValues(unfolded, 'DKIM-Signature')
    .map((value) => /(?:^|[\s;])d=([^\s;]+)/i.exec(value)?.[1]?.toLowerCase())
    .filter((d): d is string => Boolean(d));
}

export function parseSenderAuth(rawHeaders: string): SenderAuthSignals {
  const unfolded = unfoldHeaders(rawHeaders);
  const authResults = headerValues(unfolded, 'Authentication-Results').join('; ');
  const dkimFromAuth = parseDkim(authResults);
  const sigDomains = parseDkimSignatureDomains(unfolded);
  const dkim =
    dkimFromAuth.length > 0
      ? dkimFromAuth
      : sigDomains.map((domain) => ({ result: 'unknown' as const, domain }));

  return {
    fromDomain: domainFromAddress(headerValues(unfolded, 'From')[0]),
    replyToDomain: domainFromAddress(headerValues(unfolded, 'Reply-To')[0]),
    returnPathDomain: domainFromAddress(headerValues(unfolded, 'Return-Path')[0]),
    spf: parseMethod(authResults, 'spf'),
    dkim,
    dmarc: parseMethod(authResults, 'dmarc'),
    hasListUnsubscribe: headerValues(unfolded, 'List-Unsubscribe').length > 0,
    hasListUnsubscribePost: headerValues(unfolded, 'List-Unsubscribe-Post').length > 0,
  };
}
