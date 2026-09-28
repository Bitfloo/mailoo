import type { EmailMeta } from '../../types/index.js';
import type { SenderAuthSignals } from '../../utils/auth-headers.js';
import type { ArrivalEmail } from './state.js';
import { buildMailState, extractLinks } from './state.js';

const security: SenderAuthSignals = {
  dkim: [],
  hasListUnsubscribe: false,
  hasListUnsubscribePost: false,
};

function email(overrides: Partial<EmailMeta> = {}): ArrivalEmail {
  return {
    account: 'personal',
    mailbox: 'INBOX',
    meta: {
      id: '10',
      subject: 'Invoice https://billing.example.com/pay',
      from: { name: 'Billing', address: 'billing@example.com' },
      to: [{ address: 'me@example.com' }],
      date: '2026-09-21T00:00:00.000Z',
      seen: false,
      flagged: false,
      answered: false,
      hasAttachments: false,
      labels: [],
      ...overrides,
    },
  };
}

describe('extractLinks', () => {
  it('pulls http(s) URLs from subject text', () => {
    expect(extractLinks('See https://example.com/a and http://example.com/b.')).toEqual([
      { text: 'https://example.com/a', url: 'https://example.com/a' },
      { text: 'http://example.com/b', url: 'http://example.com/b' },
    ]);
  });
});

describe('buildMailState', () => {
  const subject = 'Invoice https://billing.example.com/pay';
  const filename = 'inv.pdf';
  const displayName = 'Billing';
  const address = 'billing@example.com';

  function withoutBody() {
    return buildMailState({
      email: email({ subject, from: { name: displayName, address } }),
      security,
      bodyText: 'secret password body',
      attachmentNames: [{ filename, mime: 'application/pdf' }],
      includeBody: false,
      bodyMaxChars: 6000,
    });
  }

  it('keeps the subject byte-identical to the input', () => {
    expect(withoutBody().message.subject).toBe(subject);
  });

  it('keeps the attachment filename and mime byte-identical to the input', () => {
    expect(withoutBody().message.attachments).toEqual([{ filename, mime: 'application/pdf' }]);
  });

  it('leaves the body empty when includeBody is false', () => {
    expect(withoutBody().message.body).toBe('');
  });

  it('keeps the sender display name byte-identical to the input', () => {
    expect(withoutBody().message.sender.display_name).toBe(displayName);
  });

  it('keeps the sender address from the input', () => {
    expect(withoutBody().message.sender.email).toBe(address);
  });

  it('copies links from the subject when includeBody is false', () => {
    expect(withoutBody().message.links).toEqual([
      { text: 'https://billing.example.com/pay', url: 'https://billing.example.com/pay' },
    ]);
  });

  it('truncates body when includeBody is true', () => {
    const state = buildMailState({
      email: email({ subject: 'Hi' }),
      security,
      bodyText: 'abcdefghij',
      attachmentNames: [],
      includeBody: true,
      bodyMaxChars: 4,
    });
    expect(state.message.body).toBe('abcd');
  });
});
