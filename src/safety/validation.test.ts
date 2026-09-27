import {
  parseMessageUid,
  recipientEmail,
  resolveWebhookUrl,
  sanitizeMailboxName,
  sanitizeSearchQuery,
  sanitizeTemplateVariable,
  validateInputLength,
  validateLabelName,
  validateWebhookUrl,
} from './validation.js';

describe('sanitizeMailboxName', () => {
  it('returns a valid trimmed name', () => {
    expect(sanitizeMailboxName('  INBOX  ')).toBe('INBOX');
  });

  it('throws on empty string', () => {
    expect(() => sanitizeMailboxName('')).toThrow('must not be empty');
  });

  it('throws on whitespace-only string', () => {
    expect(() => sanitizeMailboxName('   ')).toThrow('must not be empty');
  });

  it('throws when name contains *', () => {
    expect(() => sanitizeMailboxName('INBOX*')).toThrow('wildcard');
  });

  it('throws when name contains %', () => {
    expect(() => sanitizeMailboxName('INBOX%')).toThrow('wildcard');
  });

  it('allows names with dots and slashes', () => {
    expect(sanitizeMailboxName('INBOX/Subfolder.Label')).toBe('INBOX/Subfolder.Label');
  });

  it('allows a Gmail special-use path', () => {
    expect(sanitizeMailboxName('[Gmail]/All Mail')).toBe('[Gmail]/All Mail');
  });

  it.each([
    'INBOX\r\nSent',
    'IN\x00BOX',
    'INBOX\x7F',
  ])('throws when the name contains a control character (%j)', (name) => {
    expect(() => sanitizeMailboxName(name)).toThrow('control characters');
  });

  it.each([
    'INBOX"',
    'INBOX\\Sent',
    'INBOX{5}',
    'INBOX(old)',
  ])('throws when the name contains an IMAP special character (%j)', (name) => {
    expect(() => sanitizeMailboxName(name)).toThrow('IMAP special');
  });
});

describe('parseMessageUid', () => {
  it.each(['1', '42', '4294967295'])('returns a canonical positive UID (%s)', (emailId) => {
    expect(parseMessageUid(emailId)).toBe(emailId);
  });

  it.each([
    '0',
    '-1',
    '01',
    '1.5',
    '1e2',
    ' 4',
    '4 ',
    '12abc',
    '1:*',
    '1:5',
    '1,2',
    '*',
    '$',
    '',
  ])('throws when the id is %j', (emailId) => {
    expect(() => parseMessageUid(emailId)).toThrow('positive integer UID');
  });

  it('throws when the id is above the 32-bit UID maximum', () => {
    expect(() => parseMessageUid('4294967296')).toThrow('positive integer UID');
  });
});

describe('sanitizeSearchQuery', () => {
  it('returns a clean query', () => {
    expect(sanitizeSearchQuery('hello world')).toBe('hello world');
  });

  it('strips control characters', () => {
    expect(sanitizeSearchQuery('hello\x00\x01world')).toBe('helloworld');
  });

  it('throws on empty after sanitization', () => {
    expect(() => sanitizeSearchQuery('\x00\x01')).toThrow('must not be empty');
  });

  it('preserves tabs', () => {
    expect(sanitizeSearchQuery('hello\tworld')).toBe('hello\tworld');
  });

  it('preserves newlines', () => {
    expect(sanitizeSearchQuery('hello\nworld')).toBe('hello\nworld');
  });
});

describe('validateWebhookUrl', () => {
  it('throws on invalid URL', () => {
    expect(() => validateWebhookUrl('not-a-url')).toThrow('Invalid webhook URL');
  });

  it('throws on non-http(s) protocol', () => {
    expect(() => validateWebhookUrl('ftp://example.com')).toThrow('http or https');
  });

  it('throws on localhost', () => {
    expect(() => validateWebhookUrl('https://localhost/hook')).toThrow('loopback or private');
  });

  it('throws on 127.0.0.1', () => {
    expect(() => validateWebhookUrl('https://127.0.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on 10.x.x.x', () => {
    expect(() => validateWebhookUrl('https://10.0.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on 172.16-31.x.x', () => {
    expect(() => validateWebhookUrl('https://172.16.0.1/hook')).toThrow('loopback or private');
    expect(() => validateWebhookUrl('https://172.31.255.255/hook')).toThrow('loopback or private');
  });

  it('throws on 192.168.x.x', () => {
    expect(() => validateWebhookUrl('https://192.168.1.1/hook')).toThrow('loopback or private');
  });

  it('throws on ::1', () => {
    // Note: URL parser keeps brackets in hostname for IPv6, so the source
    // comparison against '::1' won't match '[::1]'. This tests current behaviour.
    expect(() => validateWebhookUrl('http://::1/hook')).toThrow();
  });

  it('throws on 0.0.0.0', () => {
    expect(() => validateWebhookUrl('https://0.0.0.0/hook')).toThrow('loopback or private');
  });

  it('allows valid public https URL', () => {
    expect(() => validateWebhookUrl('https://hooks.example.com/wh')).not.toThrow();
  });

  it('allows valid public http URL', () => {
    expect(() => validateWebhookUrl('http://hooks.example.com/wh')).not.toThrow();
  });

  it('throws on a link-local metadata address', () => {
    expect(() => validateWebhookUrl('https://169.254.169.254/latest/meta-data/')).toThrow(
      'loopback or private',
    );
  });

  it('throws on the rest of 0.0.0.0/8', () => {
    expect(() => validateWebhookUrl('http://0.1.2.3/hook')).toThrow('loopback or private');
  });

  it('throws on an IPv4-mapped loopback address', () => {
    expect(() => validateWebhookUrl('http://[::ffff:127.0.0.1]/hook')).toThrow(
      'loopback or private',
    );
    expect(() => validateWebhookUrl('http://[::ffff:169.254.169.254]/hook')).toThrow(
      'loopback or private',
    );
  });

  it('throws on an IPv6 link-local address', () => {
    expect(() => validateWebhookUrl('http://[fe80::1]/hook')).toThrow('loopback or private');
  });

  it('throws on an IPv6 unique-local address', () => {
    expect(() => validateWebhookUrl('http://[fd00::1]/hook')).toThrow('loopback or private');
  });

  it('throws on a metadata hostname', () => {
    expect(() => validateWebhookUrl('http://metadata.google.internal/computeMetadata/v1/')).toThrow(
      'loopback or private',
    );
  });

  it('allows a decimal form of a public address', () => {
    expect(() => validateWebhookUrl('http://134744072/')).not.toThrow();
  });

  it('allows a private address only when the policy opts in', () => {
    expect(() =>
      validateWebhookUrl('https://127.0.0.1/hook', { allowPrivate: true }),
    ).not.toThrow();
    expect(() => validateWebhookUrl('ftp://127.0.0.1/hook', { allowPrivate: true })).toThrow(
      'http or https',
    );
  });

  it('rejects a hostname that resolves to a private address', async () => {
    await expect(
      resolveWebhookUrl('https://hooks.example.com/hook', {
        lookup: async () => ['10.1.2.3'],
      }),
    ).rejects.toThrow('loopback or private');
  });

  it('allows a hostname that resolves to a public address', async () => {
    await expect(
      resolveWebhookUrl('https://hooks.example.com/hook', {
        lookup: async () => ['192.0.2.10'],
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a hostname lookup that does not finish', async () => {
    await expect(
      resolveWebhookUrl('https://hooks.example.com/hook', {
        lookup: async () => new Promise<string[]>(() => {}),
        lookupTimeoutMs: 20,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('sanitizeTemplateVariable', () => {
  it('returns value as-is when html is false', () => {
    expect(sanitizeTemplateVariable('<b>test</b>', false)).toBe('<b>test</b>');
  });

  it('escapes & when html is true', () => {
    expect(sanitizeTemplateVariable('a & b', true)).toBe('a &amp; b');
  });

  it('escapes < and > when html is true', () => {
    expect(sanitizeTemplateVariable('<div>', true)).toBe('&lt;div&gt;');
  });

  it('escapes double quotes when html is true', () => {
    expect(sanitizeTemplateVariable('"hello"', true)).toBe('&quot;hello&quot;');
  });

  it('escapes single quotes when html is true', () => {
    expect(sanitizeTemplateVariable("it's", true)).toBe('it&#39;s');
  });

  it('escapes all special chars together', () => {
    expect(sanitizeTemplateVariable('<a href="x">&\'', true)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;',
    );
  });
});

describe('validateLabelName', () => {
  it('throws on empty string', () => {
    expect(() => validateLabelName('')).toThrow('must not be empty');
  });

  it('throws on whitespace-only string', () => {
    expect(() => validateLabelName('   ')).toThrow('must not be empty');
  });

  it('throws on >200 chars', () => {
    expect(() => validateLabelName('a'.repeat(201))).toThrow('must not exceed 200');
  });

  it('allows exactly 200 chars', () => {
    expect(validateLabelName('a'.repeat(200))).toBe('a'.repeat(200));
  });

  it('throws on control characters', () => {
    expect(() => validateLabelName('label\x00name')).toThrow('control characters');
  });

  it('trims whitespace and returns valid name', () => {
    expect(validateLabelName('  Important  ')).toBe('Important');
  });

  it('allows a nested label', () => {
    expect(validateLabelName('Work/Urgent')).toBe('Work/Urgent');
  });

  it.each([
    'Bad"Tag',
    'Bad\\Tag',
    '\\Seen',
    'Bad*Tag',
    'Tag)',
  ])('throws when the name contains an IMAP special character (%j)', (name) => {
    expect(() => validateLabelName(name)).toThrow('IMAP special');
  });

  it.each([
    '../Secret',
    'Work//Urgent',
    'Work/',
    '.',
  ])('throws when a path segment is empty or relative (%j)', (name) => {
    expect(() => validateLabelName(name)).toThrow('relative path');
  });
});

describe('validateInputLength', () => {
  it('throws when over max', () => {
    expect(() => validateInputLength('12345', 3, 'field')).toThrow(
      'field exceeds maximum length of 3',
    );
  });

  it('allows at exact max length', () => {
    expect(() => validateInputLength('123', 3, 'field')).not.toThrow();
  });

  it('allows under max length', () => {
    expect(() => validateInputLength('ab', 5, 'name')).not.toThrow();
  });
});

describe('recipientEmail', () => {
  it('accepts a normal address', () => {
    expect(recipientEmail.parse('user@example.com')).toBe('user@example.com');
  });

  it('emits a JSON Schema pattern without regex lookaheads', () => {
    const schema = recipientEmail.toJSONSchema();
    expect(JSON.stringify(schema)).not.toMatch(/\(\?[!<=]/);
  });
});
