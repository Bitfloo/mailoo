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
  WebhookLookupTimeoutError,
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

  it('accepts a name that contains parentheses', () => {
    expect(sanitizeMailboxName('Archive (2024)')).toBe('Archive (2024)');
  });

  it('accepts a name that contains a quote', () => {
    expect(sanitizeMailboxName('a"b')).toBe('a"b');
  });

  it.each([
    'INBOX\r\nSent',
    'IN\x00BOX',
    'INBOX\x7F',
  ])('throws when the name contains a control character (%j)', (name) => {
    expect(() => sanitizeMailboxName(name)).toThrow('control characters');
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

  it('throws on an IPv6 loopback address', () => {
    expect(() => validateWebhookUrl('http://[::1]/hook')).toThrow('loopback or private');
  });

  it('throws on a hex IPv4-mapped loopback address', () => {
    expect(() => validateWebhookUrl('http://[::ffff:7f00:1]/hook')).toThrow('loopback or private');
  });

  it('throws on the metadata address 100.100.100.200', () => {
    expect(() => validateWebhookUrl('http://100.100.100.200/hook')).toThrow('loopback or private');
  });

  it('throws on a shared address space address', () => {
    expect(() => validateWebhookUrl('http://100.64.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on an IPv4-compatible loopback address', () => {
    expect(() => validateWebhookUrl('http://[::7f00:1]/hook')).toThrow('loopback or private');
  });

  it('throws on a NAT64 address that embeds a private IPv4 address', () => {
    expect(() => validateWebhookUrl('http://[64:ff9b::a00:1]/hook')).toThrow('loopback or private');
  });

  it('throws on a local-use NAT64 address', () => {
    expect(() => validateWebhookUrl('http://[64:ff9b:1::a00:1]/hook')).toThrow(
      'loopback or private',
    );
  });

  it('throws on a local-use NAT64 address that looks like a public IPv4', () => {
    expect(() => validateWebhookUrl('http://[64:ff9b:1::808:808]/hook')).toThrow(
      'loopback or private',
    );
  });

  // First bit after /48. Any longer prefix of this network leaves it out.
  it('throws on a local-use NAT64 address that a one-bit longer prefix would allow', () => {
    expect(() => validateWebhookUrl('http://[64:ff9b:1:8000::1]/hook')).toThrow(
      'loopback or private',
    );
  });

  // Sibling under /47. A wider block of this network would refuse it.
  it('allows an address outside the local-use NAT64 prefix', () => {
    expect(() => validateWebhookUrl('http://[64:ff9b:0:1::1]/hook')).not.toThrow();
  });

  it('throws on a discard-only address', () => {
    expect(() => validateWebhookUrl('http://[100::1]/hook')).toThrow('loopback or private');
  });

  // First bit after /64. Any longer prefix of this network leaves it out.
  it('throws on a discard-only address that a one-bit longer prefix would allow', () => {
    expect(() => validateWebhookUrl('http://[100:0:0:0:8000::1]/hook')).toThrow(
      'loopback or private',
    );
  });

  // Sibling under /62. Widening either blocked /64 to /62 would refuse it.
  it('allows an address outside the discard-only and dummy prefixes', () => {
    expect(() => validateWebhookUrl('http://[100:0:0:2::1]/hook')).not.toThrow();
  });

  it('throws on a dummy prefix address', () => {
    expect(() => validateWebhookUrl('http://[100:0:0:1::1]/hook')).toThrow('loopback or private');
  });

  // First bit after /64. Any longer prefix of this network leaves it out.
  it('throws on a dummy prefix address that a one-bit longer prefix would allow', () => {
    expect(() => validateWebhookUrl('http://[100:0:0:1:8000::1]/hook')).toThrow(
      'loopback or private',
    );
  });

  it('throws on an SRv6 SID address', () => {
    expect(() => validateWebhookUrl('http://[5f00::1]/hook')).toThrow('loopback or private');
  });

  // First bit after /16. Any longer prefix of this network leaves it out.
  it('throws on an SRv6 SID address that a one-bit longer prefix would allow', () => {
    expect(() => validateWebhookUrl('http://[5f00:8000::1]/hook')).toThrow('loopback or private');
  });

  // Sibling under /15. A wider block of this network would refuse it.
  it('allows an address outside the SRv6 SID prefix', () => {
    expect(() => validateWebhookUrl('http://[5f01::1]/hook')).not.toThrow();
  });

  it('throws on a 6to4 address that embeds a private IPv4 address', () => {
    expect(() => validateWebhookUrl('http://[2002:a00:1::]/hook')).toThrow('loopback or private');
  });

  it('throws on an IETF protocol assignment address', () => {
    expect(() => validateWebhookUrl('http://192.0.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on a benchmarking address', () => {
    expect(() => validateWebhookUrl('http://198.18.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on a reserved address', () => {
    expect(() => validateWebhookUrl('http://240.0.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on an IPv6 site-local address', () => {
    expect(() => validateWebhookUrl('http://[fec0::1]/hook')).toThrow('loopback or private');
  });

  it('allows an embedded public IPv4 address', () => {
    expect(() => validateWebhookUrl('http://[::ffff:c000:20a]/hook')).not.toThrow();
    expect(() => validateWebhookUrl('http://[::c000:20a]/hook')).not.toThrow();
    expect(() => validateWebhookUrl('http://[64:ff9b::c000:20a]/hook')).not.toThrow();
    expect(() => validateWebhookUrl('http://[2002:c000:20a::]/hook')).not.toThrow();
  });

  it('throws on the metadata.goog hostname', () => {
    expect(() => validateWebhookUrl('http://metadata.goog/')).toThrow('loopback or private');
  });

  it('throws on a localhost subdomain', () => {
    expect(() => validateWebhookUrl('https://foo.localhost/hook')).toThrow('loopback or private');
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
    ).rejects.toThrow(WebhookLookupTimeoutError);
  });

  it('reports a failed lookup instead of a private-address refusal', async () => {
    await expect(
      resolveWebhookUrl('https://hooks.example.com/hook', {
        lookup: async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        },
      }),
    ).rejects.toThrow(/webhook address lookup failed/i);
  });

  it('does not treat the timeout text on an ordinary error as a timeout', async () => {
    await expect(
      resolveWebhookUrl('https://hooks.example.com/hook', {
        lookup: async () => {
          throw new Error('Webhook address lookup timed out');
        },
      }),
    ).rejects.toThrow(/webhook address lookup failed/i);
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

  it('accepts a Gmail system label', () => {
    expect(validateLabelName('\\Starred')).toBe('\\Starred');
  });

  it('accepts a label that contains parentheses', () => {
    expect(validateLabelName('Receipts (2024)')).toBe('Receipts (2024)');
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
