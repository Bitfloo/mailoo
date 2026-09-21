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
  it('keeps body empty when includeBody is false', () => {
    const state = buildMailState({
      email: email(),
      security,
      bodyText: 'secret password body',
      attachmentNames: [{ filename: 'inv.pdf', mime: 'application/pdf' }],
      includeBody: false,
      bodyMaxChars: 6000,
    });
    expect(state.message.body).toBe('');
    expect(state.message.sender.email).toBe('billing@example.com');
    expect(state.message.sender.display_name).toBe('Billing');
    expect(state.message.links).toEqual([
      { text: 'https://billing.example.com/pay', url: 'https://billing.example.com/pay' },
    ]);
    expect(state.message.attachments).toEqual([{ filename: 'inv.pdf', mime: 'application/pdf' }]);
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
