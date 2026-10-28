import { inspect } from 'node:util';

import { redactedError, redactSentCredentials } from './credential-redaction.js';

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
// Encodes to "C%40fe%2FBad": uppercase hex letters both inside and outside an escape.
const HEX_LETTER_SECRET = 'C@fe/Bad';
// Encodes to "pw%3A%3D%3EZq9xKd": the hex letters A, D and E no other fixture puts in an escape.
const ADE_ESCAPE_SECRET = 'pw:=>Zq9xKd';
// Encode to "%C3%A0-Pa55word" and "%C3%A9-Pa55word": a hex letter beside the digit 0, then 9.
const DIGIT_0_ESCAPE_SECRET = 'à-Pa55word';
const DIGIT_9_ESCAPE_SECRET = 'é-Pa55word';
// Encodes to "pa55%3ACAFE": hex letters side by side outside an escape.
const HEX_RUN_SECRET = 'pa55:CAFE';
// encodeURIComponent throws a URIError on a UTF-16 surrogate with no partner.
const LONE_SURROGATE_SECRET = 'Pa55\ud800word';
// U+10000 as its two UTF-16 halves; a secret that ends in the first half is not in a text that
// holds the whole pair.
const HIGH_SURROGATE = String.fromCharCode(0xd800);
const SURROGATE_PAIR = `${HIGH_SURROGATE}${String.fromCharCode(0xdc00)}`;
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
// "the Bearer scheme is required": names the scheme outside an auth= field.
const BASE64_BEARER_PROSE = 'dGhlIEJlYXJlciBzY2hlbWUgaXMgcmVxdWlyZWQ=';
// User "a", token "t": a one-character login and token make the shortest blob.
const XOAUTH2_SHORTEST = 'dXNlcj1hAWF1dGg9QmVhcmVyIHQBAQ==';
// "auth=Bearer xyz" in 20 base64 characters and "auth=Bearer xy" in 19 and a pad: either side of
// the shortest run the blob scan decodes.
const BASE64_RUN_20 = 'YXV0aD1CZWFyZXIgeHl6';
const BASE64_RUN_19 = 'YXV0aD1CZWFyZXIgeHk=';

const REPLY = 'Invalid login: 535 5.7.8 Error: authentication failed:';

// ECMAScript's SyntaxCharacter set: what a RegExp reads as syntax unless it is escaped.
const REGEX_SYNTAX_CHARACTERS = Array.from('\\^$.*+?()[]{}|');

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

  // The fixtures above read the same percent-encoded, so only this row needs the raw shape.
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

  // A config password can hold one, and the redaction runs inside a catch block.
  it('should redact a raw secret that holds a lone surrogate', () => {
    const reply = `${REPLY} ${LONE_SURROGATE_SECRET}`;
    expect(redactSentCredentials(reply, { user: USER, secrets: [LONE_SURROGATE_SECRET] })).toBe(
      `${REPLY} [redacted]`,
    );
  });

  // Each is replaced before encoding, or encodeURIComponent throws on the second.
  it('should redact a raw secret that holds two lone surrogates', () => {
    const twice = LONE_SURROGATE_SECRET.repeat(2);
    expect(redactSentCredentials(`${REPLY} ${twice}`, { user: USER, secrets: [twice] })).toBe(
      `${REPLY} [redacted]`,
    );
  });

  it.each([
    ['a long secret', `abcdefgh${HIGH_SURROGATE}`, `abcdefgh${SURROGATE_PAIR}`],
    ['a short secret', `ab${HIGH_SURROGATE}`, `ab${SURROGATE_PAIR}`],
  ])(
    'should leave the text unchanged when %s that ends in a lone surrogate meets only half of a pair',
    (_size, secret, echo) => {
      const reply = `${REPLY} ${echo}`;
      expect(redactSentCredentials(reply, { user: USER, secrets: [secret] })).toBe(reply);
    },
  );

  // UTF-8 sends U+FFFD, bytes EF BF BD, in place of the lone surrogate.
  it('should redact the percent-encoded form of a secret that holds a lone surrogate', () => {
    const reply = `${REPLY} Pa55%ef%bf%bdword`;
    expect(redactSentCredentials(reply, { user: USER, secrets: [LONE_SURROGATE_SECRET] })).toBe(
      `${REPLY} [redacted]`,
    );
  });

  it.each([
    ['a lowercase escape before an uppercase one', URL_SECRET, 'P%40ss%20W%2frd%2B%259z'],
    ['an uppercase escape before a lowercase one', URL_SECRET, 'P%40ss%20W%2Frd%2b%259z'],
    ['both cases inside one escape', NON_ASCII_PASSWORD, 'Za%c5%Bc%C3%b3%C5%82%C4%87-Has%C5%82o9'],
    ['a lowercase escape beside uppercase letters', HEX_LETTER_SECRET, 'C%40fe%2fBad'],
    ['lowercase escapes of the hex letters A, D and E', ADE_ESCAPE_SECRET, 'pw%3a%3d%3eZq9xKd'],
    ['a lowercase hex letter beside the digit 0', DIGIT_0_ESCAPE_SECRET, '%c3%a0-Pa55word'],
    ['a lowercase hex letter beside the digit 9', DIGIT_9_ESCAPE_SECRET, '%c3%a9-Pa55word'],
  ])('should redact the percent-encoded secret written with %s', (_case, secret, echo) => {
    expect(redactSentCredentials(`${REPLY} ${echo}`, { user: USER, secrets: [secret] })).toBe(
      `${REPLY} [redacted]`,
    );
  });

  it.each([
    ['before the escapes', 'c%40fe%2FBad'],
    ['right after an escape', 'C%40fe%2Fbad'],
  ])('should keep a percent-encoded echo whose letter %s differs in case', (_where, echo) => {
    const reply = `${REPLY} ${echo}`;
    expect(redactSentCredentials(reply, { user: USER, secrets: [HEX_LETTER_SECRET] })).toBe(reply);
  });

  it('should keep a percent-encoded echo whose hex letters outside the escapes differ in case', () => {
    const reply = `${REPLY} pa55%3acafe`;
    expect(redactSentCredentials(reply, { user: USER, secrets: [HEX_RUN_SECRET] })).toBe(reply);
  });

  it.each([
    ['AUTH LOGIN', AUTH_LOGIN_NON_ASCII],
    ['AUTH PLAIN', AUTH_PLAIN_NON_ASCII],
  ])('should redact the %s form of a non-ASCII password encoded as UTF-8', (_form, wire) => {
    const nonAscii = { user: USER, secrets: [NON_ASCII_PASSWORD] };
    expect(redactSentCredentials(`${REPLY} ${wire}`, nonAscii)).toBe(`${REPLY} [redacted]`);
  });

  // A glued byte shifts the base64 alignment, so only the shape built from the known token matches.
  it('should redact the XOAUTH2 blob of the known token when it does not start on a base64 boundary', () => {
    const reply = `${REPLY} Z${XOAUTH2_KNOWN_TOKEN}`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} Z[redacted]`);
  });

  it('should redact an XOAUTH2 blob carrying a token it was not told about', () => {
    const reply = `${REPLY} ${XOAUTH2_UNKNOWN_TOKEN}`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} [redacted]`);
  });

  it('should redact the shortest XOAUTH2 blob, from a one-character login and token', () => {
    const reply = `${REPLY} ${XOAUTH2_SHORTEST}`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} [redacted]`);
  });

  it('should keep an equals sign that follows the two padding characters of an XOAUTH2 blob', () => {
    const reply = `${REPLY} ${XOAUTH2_SHORTEST}=`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} [redacted]=`);
  });

  it('should redact a 20-character base64 run that decodes to an auth=Bearer field', () => {
    const reply = `${REPLY} ${BASE64_RUN_20}`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} [redacted]`);
  });

  it('should leave a 19-character base64 run that decodes to an auth=Bearer field unchanged', () => {
    const reply = `${REPLY} ${BASE64_RUN_19}`;
    expect(redactSentCredentials(reply, sent)).toBe(reply);
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

  it('should redact a whole Bearer token of every token character after mixed whitespace', () => {
    const reply = `${REPLY} Bearer \taB9_c~d.e-f+g/h===`;
    expect(redactSentCredentials(reply, sent)).toBe(`${REPLY} Bearer \t[redacted]`);
  });

  it.each([
    ['a word that only ends in Bearer', `${REPLY} NotBearer abcdef`],
    ['a word that starts with Bearer', `${REPLY} Bearers abcdef`],
    ['a Bearer scheme with no token after it', `${REPLY} Bearer (expired)`],
  ])('should leave %s unchanged', (_shape, reply) => {
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

  it('should leave a base64 run that names Bearer outside an auth= field unchanged', () => {
    const reply = `${REPLY} ${BASE64_BEARER_PROSE}`;
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
    const repeating = { user: USER, secrets: ['kkkkkkkk'] };
    expect(redactSentCredentials(`${REPLY} kkkkkkkkk`, repeating)).toBe(`${REPLY} [redacted]`);
  });

  it('should redact a secret at the very start of the text', () => {
    expect(redactSentCredentials(`${PASSWORD} rejected`, sent)).toBe('[redacted] rejected');
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

  it.each([
    ['a one-character secret inside words', 'q', '535 5.7.8 Request quota exceeded'],
    ['a seven-character secret inside a word', 'kkkkkkk', `${REPLY} zzkkkkkkkzz`],
    ['the AUTH LOGIN form of a short secret', 'q', `${REPLY} cQ==`],
    ['a short percent-encoded secret with mixed-case escapes', '/:', `${REPLY} x%2f%3Ay`],
    // Escaped as "p\.ss\$wd", nine characters: the shape is short by the text it matches.
    ['a seven-character secret with regex metacharacters', 'p.ss$wd', `${REPLY} zzp.ss$wdzz`],
  ])('should withhold the whole text when it holds %s', (_shape, secret, reply) => {
    expect(redactSentCredentials(reply, { user: USER, secrets: [secret] })).toBe('[redacted]');
  });

  it('should withhold the whole text when a short secret occurs only inside a long one', () => {
    const nested = { user: USER, secrets: ['pa55', 'xxpa55xxyy'] };
    expect(redactSentCredentials(`${REPLY} xxpa55xxyy`, nested)).toBe('[redacted]');
  });

  it('should leave the text unchanged when a short secret does not occur in it', () => {
    const reply = 'Invalid login: 535-5.7.8 Username and Password not accepted';
    expect(redactSentCredentials(reply, { user: USER, secrets: ['q'] })).toBe(reply);
  });

  it('should leave the text unchanged when a short secret occurs in it only in another case', () => {
    const reply = `${REPLY} Quota exceeded`;
    expect(redactSentCredentials(reply, { user: USER, secrets: ['q'] })).toBe(reply);
  });

  // "axbcdefgh" differs from the secret only at the metacharacter, so an unescaped "." cuts it too.
  it.each(REGEX_SYNTAX_CHARACTERS)(
    'should cut only the exact text of a long secret that holds %s',
    (ch) => {
      const reply = `${REPLY} a${ch}bcdefgh axbcdefgh`;
      expect(redactSentCredentials(reply, { user: USER, secrets: [`a${ch}bcdefgh`] })).toBe(
        `${REPLY} [redacted] axbcdefgh`,
      );
    },
  );

  it.each(REGEX_SYNTAX_CHARACTERS)(
    'should withhold the whole text when it holds a short secret with %s',
    (ch) => {
      const reply = `${REPLY} ${ch}abc`;
      expect(redactSentCredentials(reply, { user: USER, secrets: [`${ch}abc`] })).toBe(
        '[redacted]',
      );
    },
  );

  it.each([
    ['a long secret', 'abcd[redacted]wxyz'],
    ['a short secret', 'd['],
    ['a secret that runs from inside the marker past its end', 'acted]wx'],
  ])('should withhold the whole text when the text around a cut spells %s', (_size, spelled) => {
    const secrets = { user: USER, secrets: [spelled, 'long-token-0123'] };
    expect(redactSentCredentials(`${REPLY} abcdlong-token-0123wxyz`, secrets)).toBe('[redacted]');
  });

  it.each([
    ['a long secret', 'redacted', `${REPLY} redacted`],
    ['a short secret', 'ac', `${REPLY} ${PASSWORD}`],
    ['a short secret at the start of the marker', '[red', `${REPLY} ${PASSWORD}`],
    ['a short secret at the end of the marker', 'acted]', `${REPLY} ${PASSWORD}`],
  ])('should keep the text when %s matches only inside a marker', (_size, secret, reply) => {
    expect(redactSentCredentials(reply, { user: USER, secrets: [PASSWORD, secret] })).toBe(
      `${REPLY} [redacted]`,
    );
  });

  // "ct" is in neither secret nor the reply, only in each of the two markers.
  it('should keep the text when a short secret matches inside each of two markers', () => {
    const reply = `${REPLY} ${PASSWORD} then ${TOKEN}`;
    expect(redactSentCredentials(reply, { user: USER, secrets: [PASSWORD, TOKEN, 'ct'] })).toBe(
      `${REPLY} [redacted] then [redacted]`,
    );
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

  it('should cap a reply that redaction grows past 300 characters', () => {
    const reply = 'kkkkkkkk '.repeat(33);
    expect(redactSentCredentials(reply, { user: USER, secrets: ['kkkkkkkk'] })).toBe(
      `${'[redacted] '.repeat(27)}[r…`,
    );
  });

  it('should redact before cutting so a secret across the cap leaves no prefix', () => {
    const lead = 'x'.repeat(295);
    expect(redactSentCredentials(`${lead}${PASSWORD}`, sent)).toBe(`${lead}[red…`);
  });
});

const GREENMAIL_REFUSAL_TEXT = `LOGIN failed. Invalid login/password for user id ${USER}`;

// imapflow 2's refused LOGIN or AUTHENTICATE as GreenMail answers it: a generic message, the
// reason in fields, and no `serverResponseCode` because that server sends no [CODE].
function imapflowRefusal(fields: Record<string, unknown> = {}): Error {
  return Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    responseStatus: 'NO',
    response: `2 NO ${GREENMAIL_REFUSAL_TEXT}`,
    responseText: GREENMAIL_REFUSAL_TEXT,
    ...fields,
  });
}

describe('redactedError', () => {
  describe('on a login the server refused', () => {
    it('should name the refusal without a code when the server sent none', () => {
      expect(redactedError(imapflowRefusal(), sent).message).toBe('Login refused by the server');
    });

    it.each(['NO', 'BAD'])(
      'should name the refusal and its code when the server answered %s with one',
      (responseStatus) => {
        const refusal = imapflowRefusal({
          responseStatus,
          serverResponseCode: 'AUTHENTICATIONFAILED',
        });
        expect(redactedError(refusal, sent).message).toBe(
          'Login refused by the server (AUTHENTICATIONFAILED)',
        );
      },
    );

    it('should name the refusal without a code when the code is an empty string', () => {
      expect(redactedError(imapflowRefusal({ serverResponseCode: '' }), sent).message).toBe(
        'Login refused by the server',
      );
    });

    it.each([
      ['the password', PASSWORD],
      ['the access token', TOKEN],
    ])('should redact %s that the server sent back as the code', (_quoted, secret) => {
      const refusal = imapflowRefusal({ serverResponseCode: secret });
      expect(redactedError(refusal, sent).message).toBe('Login refused by the server ([redacted])');
    });

    it('should leave response and responseText off the returned error', () => {
      const refusal = imapflowRefusal({
        response: `2 NO [AUTHENTICATIONFAILED] ${PASSWORD} rejected`,
        responseText: `${PASSWORD} rejected`,
      });
      const shown = inspect(redactedError(refusal, sent));
      expect({ password: shown.includes(PASSWORD), reply: shown.includes('rejected') }).toEqual({
        password: false,
        reply: false,
      });
    });

    it('should leave the cause off the returned error', () => {
      const refusal = new Error('Command failed', { cause: new Error(`${PASSWORD} rejected`) });
      Object.assign(refusal, { authenticationFailed: true, responseStatus: 'NO' });
      expect(inspect(redactedError(refusal, sent))).not.toContain(PASSWORD);
    });

    it('should keep code, responseCode and command', () => {
      const refusal = imapflowRefusal({ code: 'AuthFailed', responseCode: 535, command: 'LOGIN' });
      expect(redactedError(refusal, sent)).toMatchObject({
        code: 'AuthFailed',
        responseCode: 535,
        command: 'LOGIN',
      });
    });
  });

  describe('on any other failure', () => {
    it.each(['Already logged out', 'Authentication failed'])(
      'should keep the message "%s" that imapflow raises with no server refusal behind it',
      (message) => {
        const notARefusal = Object.assign(new Error(message), { authenticationFailed: true });
        expect(redactedError(notARefusal, sent).message).toBe(message);
      },
    );

    it('should keep the message of a refusal of a command other than a login', () => {
      const missingFolder = Object.assign(new Error('Command failed'), {
        responseStatus: 'NO',
        serverResponseCode: 'NONEXISTENT',
        response: '3 NO [NONEXISTENT] Unknown Mailbox',
        responseText: 'Unknown Mailbox',
      });
      expect(redactedError(missingFolder, sent).message).toBe('Command failed');
    });

    it('should keep the message of a failure that has only a server code', () => {
      const withCode = Object.assign(new Error('Command failed'), {
        serverResponseCode: 'NONEXISTENT',
      });
      expect(redactedError(withCode, sent).message).toBe('Command failed');
    });

    it('should keep the message of a login flagged as failed that the server did not answer NO or BAD', () => {
      const dropped = imapflowRefusal({ responseStatus: 'BYE' });
      expect(redactedError(dropped, sent).message).toBe('Command failed');
    });

    it('should keep the redacted message of an SMTP EAUTH error', () => {
      const eauth = Object.assign(new Error(`Invalid login: 535 5.7.8 ${PASSWORD} rejected`), {
        code: 'EAUTH',
        response: `535 5.7.8 ${PASSWORD} rejected`,
        responseCode: 535,
        command: 'AUTH PLAIN',
      });
      expect(redactedError(eauth, sent)).toMatchObject({
        message: 'Invalid login: 535 5.7.8 [redacted] rejected',
        code: 'EAUTH',
        responseCode: 535,
        command: 'AUTH PLAIN',
      });
    });

    it('should redact a message that quotes the server on a failure with no refusal fields', () => {
      const quoting = new Error(`Command failed: NO [AUTHENTICATIONFAILED] ${PASSWORD} rejected`);
      expect(redactedError(quoting, sent).message).toBe(
        'Command failed: NO [AUTHENTICATIONFAILED] [redacted] rejected',
      );
    });

    it('should redact a rejection that is not an Error', () => {
      expect(redactedError(`535 5.7.8 ${PASSWORD} rejected`, sent).message).toBe(
        '535 5.7.8 [redacted] rejected',
      );
    });
  });
});
