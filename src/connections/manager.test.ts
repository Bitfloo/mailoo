import { EventEmitter } from 'node:events';

import { mcpLog } from '../logging.js';
import type { AccountConfig } from '../types/index.js';
import ConnectionManager, { bindImapLifecycle, buildImapFlowOptions } from './manager.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('imapflow', async () => {
  const { EventEmitter: EE } = await import('node:events');
  return {
    ImapFlow: class MockImapFlow extends EE {
      usable = true;

      connect = vi.fn().mockResolvedValue(undefined);

      close = vi.fn();

      logout = vi.fn().mockResolvedValue(undefined);
    },
  };
});

const account: AccountConfig = {
  name: 'test',
  email: 'user@example.com',
  username: 'user@example.com',
  password: 'x',
  imap: {
    host: 'imap.strato.de',
    port: 993,
    tls: true,
    starttls: false,
    verifySsl: true,
    disableImap4rev2: true,
  },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

describe('buildImapFlowOptions', () => {
  beforeEach(() => {
    vi.mocked(mcpLog).mockClear();
  });

  it('passes disableIMAP4rev2 through to ImapFlow', () => {
    const opts = buildImapFlowOptions(account) as {
      disableIMAP4rev2?: boolean;
      host?: string;
    };
    expect(opts.disableIMAP4rev2).toBe(true);
    expect(opts.host).toBe('imap.strato.de');
  });

  it('keeps certificate verification on when verifySsl is omitted', () => {
    const imap = { ...account.imap };
    delete (imap as { verifySsl?: boolean }).verifySsl;
    const opts = buildImapFlowOptions({ ...account, imap }) as {
      tls?: { rejectUnauthorized?: boolean };
    };
    expect(opts.tls?.rejectUnauthorized).toBe(true);
    expect(mcpLog).not.toHaveBeenCalled();
  });

  it('does not let extra TLS options turn certificate verification off', () => {
    const opts = buildImapFlowOptions(account, {
      tls: { rejectUnauthorized: false, servername: 'imap.example.com' },
    }) as { tls?: { rejectUnauthorized?: boolean; servername?: string } };
    expect(opts.tls?.rejectUnauthorized).toBe(true);
    expect(opts.tls?.servername).toBe('imap.example.com');
    expect(mcpLog).not.toHaveBeenCalled();
  });

  it('disables certificate verification only when verifySsl is false and logs that', () => {
    const opts = buildImapFlowOptions({
      ...account,
      imap: { ...account.imap, verifySsl: false },
    }) as { tls?: { rejectUnauthorized?: boolean } };
    expect(opts.tls?.rejectUnauthorized).toBe(false);
    expect(mcpLog).toHaveBeenCalledWith(
      'warning',
      'imap',
      expect.stringContaining('certificate verification is disabled'),
    );
  });

  it.each([
    [true, true, 'absent'],
    [true, false, 'absent'],
    [false, true, true],
    [false, false, 'absent'],
  ] as const)(
    'sets secure and doSTARTTLS for tls=%s starttls=%s (%s)',
    (tls, starttls, doStarttls) => {
      const opts = buildImapFlowOptions({
        ...account,
        imap: { ...account.imap, tls, starttls },
      }) as { secure?: boolean; doSTARTTLS?: boolean };
      expect(opts.secure).toBe(tls);
      if (doStarttls === true) {
        expect(opts.doSTARTTLS).toBe(true);
      } else {
        expect(opts).not.toHaveProperty('doSTARTTLS');
      }
    },
  );
});

describe('bindImapLifecycle', () => {
  it('handles ImapFlow error without killing the process', async () => {
    const client = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
    client.close = vi.fn();
    const forget = vi.fn();
    const exitCodeBefore = process.exitCode;
    bindImapLifecycle('work', client as never, forget);

    client.emit('error', new Error('socket hang up'));

    expect(forget).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(mcpLog).toHaveBeenCalledWith(
      'warning',
      'imap',
      expect.stringContaining('socket hang up'),
    );
    expect(process.exitCode).toBe(exitCodeBefore);
    await Promise.resolve();
    expect(process.listenerCount('uncaughtException')).toBeGreaterThanOrEqual(0);
  });
});

describe('ConnectionManager IMAP error', () => {
  it('forgets the client on emit(error) and stays alive', async () => {
    const manager = new ConnectionManager([account]);
    const first = await manager.getImapClient('test');
    const exitCodeBefore = process.exitCode;
    first.emit('error', new Error('broken pipe'));
    expect(process.exitCode).toBe(exitCodeBefore);
    const second = await manager.getImapClient('test');
    expect(second).not.toBe(first);
  });
});

describe('ConnectionManager.getAccount smart resolution', () => {
  const workAccount: AccountConfig = {
    ...account,
    name: 'work',
    email: 'jan@firma.example.com',
  };
  const personalAccount: AccountConfig = {
    ...account,
    name: 'personal',
    email: 'jan@home.example.com',
  };

  it('matches exact name, case-insensitive name, and email address', () => {
    const manager = new ConnectionManager([workAccount, personalAccount]);
    expect(manager.getAccount('work')).toBe(workAccount);
    expect(manager.getAccount('WORK')).toBe(workAccount);
    expect(manager.getAccount('jan@firma.example.com')).toBe(workAccount);
    expect(manager.getAccount('JAN@HOME.EXAMPLE.COM')).toBe(personalAccount);
  });

  it('returns the single account automatically when accountName is omitted or default', () => {
    const manager = new ConnectionManager([workAccount]);
    expect(manager.getAccount()).toBe(workAccount);
    expect(manager.getAccount('')).toBe(workAccount);
    expect(manager.getAccount('default')).toBe(workAccount);
    expect(manager.resolveAccountName()).toBe('work');
  });

  it('uses defaultAccount when multiple accounts are configured and accountName is omitted or default', () => {
    const manager = new ConnectionManager([workAccount, personalAccount], undefined, 'personal');
    expect(manager.getAccount()).toBe(personalAccount);
    expect(manager.getAccount('')).toBe(personalAccount);
    expect(manager.getAccount('default')).toBe(personalAccount);
  });

  it('throws a self-healing error listing available accounts with emails when not found', () => {
    const manager = new ConnectionManager([workAccount, personalAccount]);
    expect(() => manager.getAccount('unknown')).toThrow(
      'Account "unknown" not found. Available accounts: work (jan@firma.example.com), personal (jan@home.example.com)',
    );
    expect(() => manager.getAccount()).toThrow(
      'Account "" not found. Available accounts: work (jan@firma.example.com), personal (jan@home.example.com)',
    );
  });
});
