import { redactSentCredentials } from './credential-redaction.js';

const USER = 'work@example.com';
const PASSWORD = 'S3cret-Pa55word!';
const TOKEN = 'ya29.fake-access-token-0123456789';
const sent = { user: USER, secrets: [PASSWORD, TOKEN] };

// Wire forms of the fixtures above, encoded outside this suite so it does not mirror the encoder.
const AUTH_LOGIN_PASSWORD = 'UzNjcmV0LVBhNTV3b3JkIQ==';
const AUTH_PLAIN_EMPTY_AUTHZID = 'AHdvcmtAZXhhbXBsZS5jb20AUzNjcmV0LVBhNTV3b3JkIQ==';
const AUTH_PLAIN_USER_AUTHZID =
  'd29ya0BleGFtcGxlLmNvbQB3b3JrQGV4YW1wbGUuY29tAFMzY3JldC1QYTU1d29yZCE=';
const XOAUTH2_KNOWN_TOKEN =
  'dXNlcj13b3JrQGV4YW1wbGUuY29tAWF1dGg9QmVhcmVyIHlhMjkuZmFrZS1hY2Nlc3MtdG9rZW4tMDEyMzQ1Njc4OQEB';
const XOAUTH2_UNKNOWN_TOKEN =
  'dXNlcj13b3JrQGV4YW1wbGUuY29tAWF1dGg9QmVhcmVyIHlhMjkuZmFrZS11bmtub3duLXRva2VuLTk4NzY1NDMyMTABAQ==';
const URL_SECRET = 'P@ss W/rd+%9z';
const URL_SECRET_ENCODED = 'P%40ss%20W%2Frd%2B%259z';
const URL_SECRET_ENCODED_LOWER_HEX = 'P%40ss%20W%2frd%2b%259z';
const NON_ASCII_PASSWORD = 'Zażółć-Hasło9';
const AUTH_LOGIN_NON_ASCII = 'WmHFvMOzxYLEhy1IYXPFgm85';
const AUTH_PLAIN_NON_ASCII = 'AHdvcmtAZXhhbXBsZS5jb20AWmHFvMOzxYLEhy1IYXPFgm85';
// User "спартак@example.com", token "ya29.fake-unknown-tokena~x": the Cyrillic login puts a "/"
// and the "~" puts a "+" into the base64.
const XOAUTH2_PLUS_SLASH =
  'dXNlcj3RgdC/0LDRgNGC0LDQukBleGFtcGxlLmNvbQFhdXRoPUJlYXJlciB5YTI5LmZha2UtdW5rbm93bi10b2tlbmF+eAEB';
// "This is not a secret": long enough to be read as a possible XOAUTH2 blob.
const PLAIN_BASE64 = 'VGhpcyBpcyBub3QgYSBzZWNyZXQ=';
// An XOAUTH2-shaped blob reading "auth=BearerX", with no token after the scheme.
const XOAUTH2_NO_TOKEN = 'dXNlcj13b3JrQGV4YW1wbGUuY29tAWF1dGg9QmVhcmVyWAEB';

const REPLY = 'Invalid login: 535 5.7.8 Error: authentication failed:';

describe('redactSentCredentials', () => {
  it.each([
    ['the raw password', `${REPLY} ${PASSWORD}`],
    ['the AUTH LOGIN base64 password', `${REPLY} ${AUTH_LOGIN_PASSWORD}`],
    ['the AUTH PLAIN blob with an empty authzid', `${REPLY} ${AUTH_PLAIN_EMPTY_AUTHZID}`],
    ['the AUTH PLAIN blob with the user as authzid', `${REPLY} ${AUTH_PLAIN_USER_AUTHZID}`],
    ['the raw access token', `${REPLY} ${TOKEN}`],
  ])('should redact %s quoted by the server', (_form, reply) => {
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} [redacted]`);
  });

  // The fixtures above read the same percent-encoded, so only this row needs the raw needle.
  it('should redact a raw secret that percent-encoding would change', () => {
    const reply = `${REPLY} ${URL_SECRET}`;
    expect(redactSentCredentials(reply, { user: USER, secrets: [URL_SECRET] })).toBe(
      `${REPLY} [redacted]`,
    );
  });

  it('should redact the percent-encoded secret', () => {
    const reply = `${REPLY} ${URL_SECRET_ENCODED}`;
    expect(redactSentCredentials(reply, { user: USER, secrets: [URL_SECRET] })).toBe(
      `${REPLY} [redacted]`,
    );
  });

  it('should redact the percent-encoded secret with lowercase hex digits', () => {
    const reply = `${REPLY} ${URL_SECRET_ENCODED_LOWER_HEX}`;
    expect(redactSentCredentials(reply, { user: USER, secrets: [URL_SECRET] })).toBe(
      `${REPLY} [redacted]`,
    );
  });

  it.each([
    ['AUTH LOGIN', AUTH_LOGIN_NON_ASCII],
    ['AUTH PLAIN', AUTH_PLAIN_NON_ASCII],
  ])('should redact the %s form of a non-ASCII password encoded as UTF-8', (_form, wire) => {
    const nonAscii = { user: USER, secrets: [NON_ASCII_PASSWORD] };
    expect(redactSentCredentials(`${REPLY} ${wire}`, nonAscii)).toBe(`${REPLY} [redacted]`);
  });

  // A glued byte shifts the base64 alignment, so only the needle built from the known token matches.
  it('should redact the XOAUTH2 blob of the known token when it does not start on a base64 boundary', () => {
    const reply = `${REPLY} Z${XOAUTH2_KNOWN_TOKEN}`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} Z[redacted]`);
  });

  it('should redact an XOAUTH2 blob carrying a token it was not told about', () => {
    const reply = `${REPLY} ${XOAUTH2_UNKNOWN_TOKEN}`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} [redacted]`);
  });

  it('should redact a whole XOAUTH2 blob whose base64 contains a plus and a slash', () => {
    const reply = `${REPLY} ${XOAUTH2_PLUS_SLASH}`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} [redacted]`);
  });

  it('should redact a Bearer token it was not told about', () => {
    const reply = `${REPLY} Bearer ya29.fake-unknown-token-9876543210`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} Bearer [redacted]`);
  });

  it('should redact a Bearer token whose scheme is written in lowercase', () => {
    const reply = `${REPLY} bearer ya29.fake-unknown-token-9876543210`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} bearer [redacted]`);
  });

  it('should redact a whole Bearer token of every token character after more than one space', () => {
    const reply = `${REPLY} Bearer  aB9_c~d.e-f+g/h==`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} Bearer  [redacted]`);
  });

  it('should leave a word that only ends in Bearer unchanged', () => {
    const reply = `${REPLY} NotBearer abcdef`;
    expect(redactSentCredentials(reply, sent)).toBe(reply);
  });

  it('should leave a long base64 run that is not an XOAUTH2 blob unchanged', () => {
    const reply = `${REPLY} ${PLAIN_BASE64}`;
    expect(redactSentCredentials(reply, sent)).toBe(reply);
  });

  it('should leave an XOAUTH2-shaped blob with no token after the scheme unchanged', () => {
    const reply = `${REPLY} ${XOAUTH2_NO_TOKEN}`;
    expect(redactSentCredentials(reply, sent)).toBe(reply);
  });

  it('should replace overlapping secrets with one marker so neither leaves a fragment', () => {
    const overlapping = { user: USER, secrets: ['abcdefghij', 'efghijklmn'] };
    expect(redactSentCredentials(`${REPLY} abcdefghijklmn`, overlapping)).toBe(
      `${REPLY} [redacted]`,
    );
  });

  it('should keep the outer span when one secret lies inside another', () => {
    const nested = { user: USER, secrets: ['abcdefghijklmn', 'efghijkl'] };
    expect(redactSentCredentials(`${REPLY} abcdefghijklmn`, nested)).toBe(`${REPLY} [redacted]`);
  });

  it('should leave no fragment when a secret overlaps a repeat of itself', () => {
    const repeating = { user: USER, secrets: ['abababab'] };
    expect(redactSentCredentials(`${REPLY} ababababab`, repeating)).toBe(`${REPLY} [redacted]`);
  });

  it('should replace secrets that touch with one marker', () => {
    const touching = { user: USER, secrets: ['abcdefgh', 'ijklmnop'] };
    expect(redactSentCredentials(`${REPLY} abcdefghijklmnop`, touching)).toBe(
      `${REPLY} [redacted]`,
    );
  });

  it('should redact every secret when the reply quotes them in another order than the list', () => {
    const reply = `${REPLY} ${PASSWORD} then ${TOKEN}`;
    expect(redactSentCredentials(reply, { user: USER, secrets: [TOKEN, PASSWORD] })).toBe(
      `${REPLY} [redacted] then [redacted]`,
    );
  });

  it('should leave a reply that quotes no secret unchanged', () => {
    const reply = 'Invalid login: 535-5.7.8 Username and Password not accepted';
    expect(redactSentCredentials(reply, sent)).toBe(reply);
  });

  it('should leave the reply unchanged when the secrets are empty', () => {
    const reply = 'Invalid login: 535-5.7.8 Username and Password not accepted';
    expect(redactSentCredentials(reply, { user: USER, secrets: ['', undefined] })).toBe(reply);
  });

  it('should redact a one-character secret that stands as a word', () => {
    expect(redactSentCredentials(`${REPLY} q`, { user: USER, secrets: ['q'] })).toBe(
      `${REPLY} [redacted]`,
    );
  });

  it('should keep a one-character secret that only occurs inside words', () => {
    const reply = '535 5.7.8 Request quota exceeded';
    expect(redactSentCredentials(reply, { user: USER, secrets: ['q'] })).toBe(reply);
  });

  it.each([
    ['a letter on its left', `${REPLY} xq`],
    ['a digit on its right', `${REPLY} q7`],
    ['an accented letter on its left', `${REPLY} żq`],
    ['a non-Latin digit on its right', `${REPLY} q٣`],
  ])('should keep a one-character secret with %s', (_neighbour, reply) => {
    expect(redactSentCredentials(reply, { user: USER, secrets: ['q'] })).toBe(reply);
  });

  it('should keep a seven-character secret that occurs inside a word', () => {
    const reply = `${REPLY} zzkkkkkkkzz`;
    expect(redactSentCredentials(reply, { user: USER, secrets: ['kkkkkkk'] })).toBe(reply);
  });

  it('should redact an eight-character secret that occurs inside a word', () => {
    const reply = `${REPLY} zzkkkkkkkkzz`;
    expect(redactSentCredentials(reply, { user: USER, secrets: ['kkkkkkkk'] })).toBe(
      `${REPLY} zz[redacted]zz`,
    );
  });

  it('should leave a 300-character reply unchanged', () => {
    const reply = 'x'.repeat(300);
    expect(redactSentCredentials(reply, sent)).toBe(reply);
  });

  it('should cut a 301-character reply to 300 characters, marker included', () => {
    const reply = 'x'.repeat(301);
    expect(redactSentCredentials(reply, sent)).toBe(`${'x'.repeat(299)}…`);
  });

  it('should redact before cutting so a secret across the cap leaves no prefix', () => {
    const lead = 'x'.repeat(295);
    expect(redactSentCredentials(`${lead}${PASSWORD}`, sent)).toBe(`${lead}[red…`);
  });
});
