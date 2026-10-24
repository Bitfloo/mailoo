import {
  MAX_ERROR_TEXT_LENGTH,
  MIN_SUBSTRING_NEEDLE_LENGTH,
  redactSentCredentials,
} from './credential-redaction.js';

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
const URL_SECRET = 'p@ss w/rd+%9z';
const URL_SECRET_ENCODED = 'p%40ss%20w%2Frd%2B%259z';
const URL_SECRET_ENCODED_LOWER_HEX = 'p%40ss%20w%2frd%2b%259z';

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

  // A glued byte shifts the base64 alignment, so only the needle built from the known token matches.
  it('should redact the XOAUTH2 blob of the known token when it does not start on a base64 boundary', () => {
    const reply = `${REPLY} Z${XOAUTH2_KNOWN_TOKEN}`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} Z[redacted]`);
  });

  it('should redact an XOAUTH2 blob carrying a token it was not told about', () => {
    const reply = `${REPLY} ${XOAUTH2_UNKNOWN_TOKEN}`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} [redacted]`);
  });

  it('should redact a Bearer token it was not told about', () => {
    const reply = `${REPLY} Bearer ya29.fake-unknown-token-9876543210`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} Bearer [redacted]`);
  });

  it('should replace overlapping secrets with one marker so neither leaves a fragment', () => {
    const overlapping = { user: USER, secrets: ['abcdefghij', 'efghijklmn'] };
    expect(redactSentCredentials(`${REPLY} abcdefghijklmn`, overlapping)).toBe(
      `${REPLY} [redacted]`,
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

  it('should keep a secret shorter than the substring minimum that occurs inside a word', () => {
    const secret = 'k'.repeat(MIN_SUBSTRING_NEEDLE_LENGTH - 1);
    const reply = `${REPLY} zz${secret}zz`;
    expect(redactSentCredentials(reply, { user: USER, secrets: [secret] })).toBe(reply);
  });

  it('should redact a secret of the substring minimum that occurs inside a word', () => {
    const secret = 'k'.repeat(MIN_SUBSTRING_NEEDLE_LENGTH);
    expect(redactSentCredentials(`${REPLY} zz${secret}zz`, { user: USER, secrets: [secret] })).toBe(
      `${REPLY} zz[redacted]zz`,
    );
  });

  it('should leave a reply of exactly the cap unchanged', () => {
    const reply = 'x'.repeat(MAX_ERROR_TEXT_LENGTH);
    expect(redactSentCredentials(reply, sent)).toBe(reply);
  });

  it('should cut a reply one character over the cap to the cap, marker included', () => {
    const reply = 'x'.repeat(MAX_ERROR_TEXT_LENGTH + 1);
    expect(redactSentCredentials(reply, sent)).toBe(`${'x'.repeat(MAX_ERROR_TEXT_LENGTH - 1)}…`);
  });

  it('should redact before cutting so a secret across the cap leaves no prefix', () => {
    const lead = 'x'.repeat(MAX_ERROR_TEXT_LENGTH - 5);
    expect(redactSentCredentials(`${lead}${PASSWORD}`, sent)).toBe(`${lead}[red…`);
  });
});
