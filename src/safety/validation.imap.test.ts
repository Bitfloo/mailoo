import {
  parseMessageUid,
  sanitizeMailboxName,
  sanitizeSearchQuery,
  validateLabelName,
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

  it.each(['INBOX\r\nSent', 'IN\x00BOX', 'IN\x1FBOX', 'INBOX\x7F'])(
    'throws when the name contains a control character (%j)',
    (name) => {
      expect(() => sanitizeMailboxName(name)).toThrow('control characters');
    },
  );
});

describe('parseMessageUid', () => {
  it.each(['1', '42', '4294967295'])('returns a canonical positive UID (%s)', (emailId) => {
    expect(parseMessageUid(emailId)).toBe(emailId);
  });

  it.each(['0', '-1', '01', '1.5', '1e2', ' 4', '4 ', '12abc', '1:*', '1:5', '1,2', '*', '$', ''])(
    'throws when the id is %j',
    (emailId) => {
      expect(() => parseMessageUid(emailId)).toThrow('positive integer UID');
    },
  );

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

  // Tab and newline sit inside the stripped range; the characters next to them must still go.
  it.each([
    { query: 'a\x08b', char: 'U+0008' },
    { query: 'a\x0Bb', char: 'U+000B' },
    { query: 'a\x1Fb', char: 'U+001F' },
  ])('strips a control character at the edge of a stripped range ($char)', ({ query }) => {
    expect(sanitizeSearchQuery(query)).toBe('ab');
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

  it.each([
    { name: 'work\x1Flabel', char: 'U+001F' },
    { name: 'work\x7Flabel', char: 'U+007F DEL' },
  ])('throws on a control character at the edge of the rejected range ($char)', ({ name }) => {
    expect(() => validateLabelName(name)).toThrow('control characters');
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

  it.each(['../Secret', 'Work//Urgent', 'Work/', '.'])(
    'throws when a path segment is empty or relative (%j)',
    (name) => {
      expect(() => validateLabelName(name)).toThrow('relative path');
    },
  );
});
