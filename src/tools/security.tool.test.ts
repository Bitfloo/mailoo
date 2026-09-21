import type ImapService from '../services/imap.service.js';
import { parseSenderAuth } from '../utils/auth-headers.js';
import registerSecurityTools from './security.tool.js';

const FOLDED = [
  'From: Brand <noreply@brand.example>',
  'Reply-To: support@brand.example',
  'Return-Path: <bounce@mail.brand.example>',
  'Authentication-Results: mx.google.com;',
  '       spf=pass smtp.mailfrom=noreply@brand.example;',
  '       dkim=pass header.d=brand.example header.s=s1;',
  '       dkim=pass header.d=mailer.example;',
  '       dmarc=pass header.from=brand.example',
  'List-Unsubscribe: <https://brand.example/unsub?token=secret>',
  'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  '',
].join('\r\n');

type Handler = (args: {
  account: string;
  emailId: string;
  mailbox: string;
}) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;

describe('get_email_security tool', () => {
  it('sets readOnlyHint because it does not change flags', () => {
    let hints: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
    const server = {
      tool: (
        _name: string,
        _desc: string,
        _schema: unknown,
        annotations: { readOnlyHint?: boolean; destructiveHint?: boolean },
      ) => {
        hints = annotations;
      },
    };
    registerSecurityTools(server as never, { getEmailSecurity: vi.fn() } as never);
    expect(hints?.readOnlyHint).toBe(true);
    expect(hints?.destructiveHint).toBe(false);
  });

  it('returns parsed sender-auth JSON and omits unsubscribe URLs', async () => {
    const signals = { ...parseSenderAuth(FOLDED), uid: '10', mailbox: 'INBOX' };
    let handler: Handler | undefined;
    const server = {
      tool: (...args: unknown[]) => {
        handler = args[4] as Handler;
      },
    };
    const imap = { getEmailSecurity: vi.fn().mockResolvedValue(signals) };
    registerSecurityTools(server as never, imap as unknown as ImapService);
    if (!handler) throw new Error('get_email_security handler was not registered');

    const result = await handler({
      account: 'work',
      emailId: '10',
      mailbox: 'INBOX',
    });
    const payload = JSON.parse(result.content[0].text) as typeof signals;
    expect(payload).toEqual(signals);
    expect(payload.fromDomain).toBe('brand.example');
    expect(payload.spf).toBe('pass');
    expect(result.content[0].text).not.toContain('https://brand.example/unsub');
    expect(result.content[0].text).not.toContain('token=secret');
  });

  it('returns isError when getEmailSecurity throws', async () => {
    let handler: Handler | undefined;
    const server = {
      tool: (...args: unknown[]) => {
        handler = args[4] as Handler;
      },
    };
    const imap = {
      getEmailSecurity: vi.fn().mockRejectedValue(new Error('Email 10 not found in INBOX')),
    };
    registerSecurityTools(server as never, imap as unknown as ImapService);
    if (!handler) throw new Error('get_email_security handler was not registered');

    const result = await handler({
      account: 'work',
      emailId: '10',
      mailbox: 'INBOX',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to read sender authentication');
    expect(result.content[0].text).toContain('Email 10 not found in INBOX');
  });
});
