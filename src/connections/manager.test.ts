import { EventEmitter } from 'node:events';

import { mcpLog } from '../logging.js';
import type { AccountConfig } from '../types/index.js';
import ConnectionManager, { bindImapLifecycle, buildImapFlowOptions } from './manager.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

const { imapInstances, smtpTransports, connectErrors, verifyErrors } = vi.hoisted(() => ({
  // Errors the next connect()/verify() calls reject with, in order; empty means success.
  connectErrors: [] as Error[],
  verifyErrors: [] as Error[],
  imapInstances: [] as {
    options: Record<string, unknown>;
    usable: boolean;
    close: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => boolean;
  }[],
  smtpTransports: [] as {
    options: Record<string, unknown>;
    verify: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[],
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: Record<string, unknown>) => {
      const transport = {
        options,
        verify: vi.fn(
          async () =>
            new Promise<true>((resolve, reject) => {
              const error = verifyErrors.shift();
              setImmediate(() => (error ? reject(error) : resolve(true)));
            }),
        ),
        close: vi.fn(),
      };
      smtpTransports.push(transport);
      return transport;
    },
  },
}));

vi.mock('imapflow', async () => {
  const { EventEmitter: EE } = await import('node:events');
  return {
    ImapFlow: class MockImapFlow extends EE {
      usable = true;

      // A real connect resolves on a later tick, which is what lets concurrent callers overlap.
      connect = vi.fn(
        async () =>
          new Promise<void>((resolve, reject) => {
            const error = connectErrors.shift();
            setImmediate(() => (error ? reject(error) : resolve()));
          }),
      );

      close = vi.fn();

      logout = vi.fn().mockResolvedValue(undefined);

      constructor(public options: Record<string, unknown>) {
        super();
        imapInstances.push(this);
      }
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

describe('ConnectionManager.getImapClient', () => {
  beforeEach(() => {
    imapInstances.length = 0;
  });

  it('should build exactly one client when 20 callers ask for the same account at once', async () => {
    const manager = new ConnectionManager([account]);
    const clients = await Promise.all(
      Array.from({ length: 20 }, async () => manager.getImapClient('test')),
    );
    expect(imapInstances).toHaveLength(1);
    expect(new Set(clients).size).toBe(1);
  });

  it('should replace a cached client that is no longer usable', async () => {
    const manager = new ConnectionManager([account]);
    const first = await manager.getImapClient('test');
    imapInstances[0].usable = false;
    const second = await manager.getImapClient('test');
    expect(second).not.toBe(first);
    expect(imapInstances[0].close).toHaveBeenCalledOnce();
  });

  it('should reconnect on the next call after the cached client emitted close', async () => {
    const manager = new ConnectionManager([account]);
    const first = await manager.getImapClient('test');
    first.emit('close');
    const second = await manager.getImapClient('test');
    expect(second).not.toBe(first);
    expect(imapInstances).toHaveLength(2);
  });
});

describe('ConnectionManager.closeAll', () => {
  beforeEach(() => {
    imapInstances.length = 0;
  });

  it('should log out a client whose connect was still in flight when closeAll ran', async () => {
    const manager = new ConnectionManager([account]);
    const pending = manager.getImapClient('test');
    await manager.closeAll();
    await pending;
    expect(imapInstances).toHaveLength(1);
    expect(imapInstances[0].logout).toHaveBeenCalledOnce();
  });

  it('should log out every cached IMAP client', async () => {
    const manager = new ConnectionManager([account, { ...account, name: 'second' }]);
    await manager.getImapClient('test');
    await manager.getImapClient('second');
    await manager.closeAll();
    expect(imapInstances.map((client) => client.logout.mock.calls.length)).toEqual([1, 1]);
  });

  it('should close every cached SMTP transport', async () => {
    smtpTransports.length = 0;
    const manager = new ConnectionManager([account, { ...account, name: 'second' }]);
    await manager.getSmtpTransport('test');
    await manager.getSmtpTransport('second');
    await manager.closeAll();
    expect(smtpTransports.map((transport) => transport.close.mock.calls.length)).toEqual([1, 1]);
  });

  it('should connect afresh after closeAll', async () => {
    const manager = new ConnectionManager([account]);
    const first = await manager.getImapClient('test');
    await manager.closeAll();
    const second = await manager.getImapClient('test');
    expect(second).not.toBe(first);
  });
});

describe('ConnectionManager SMTP transport options', () => {
  beforeEach(() => {
    smtpTransports.length = 0;
  });

  async function optionsFor(
    smtp: Partial<AccountConfig['smtp']>,
  ): Promise<Record<string, unknown>> {
    const manager = new ConnectionManager([{ ...account, smtp: { ...account.smtp, ...smtp } }]);
    await manager.getSmtpTransport('test');
    return smtpTransports[0].options;
  }

  it('should verify the server certificate when verifySsl is true', async () => {
    const options = await optionsFor({ verifySsl: true });
    expect(options.tls).toEqual({ rejectUnauthorized: true });
  });

  it('should skip certificate verification only when verifySsl is false', async () => {
    const options = await optionsFor({ verifySsl: false });
    expect(options.tls).toEqual({ rejectUnauthorized: false });
  });

  it('should pool one connection for 100 messages when no pool block is configured', async () => {
    const options = await optionsFor({});
    expect(options).toMatchObject({ pool: true, maxConnections: 1, maxMessages: 100 });
  });

  it('should not pool when pool.enabled is false', async () => {
    const options = await optionsFor({
      pool: { enabled: false, maxConnections: 5, maxMessages: 10 },
    });
    expect(options.pool).toBe(false);
    expect(options).not.toHaveProperty('maxConnections');
  });

  it.each([
    [true, false, { secure: true, requireTLS: false, ignoreTLS: false }],
    [false, true, { secure: false, requireTLS: true, ignoreTLS: false }],
    [false, false, { secure: false, requireTLS: false, ignoreTLS: true }],
  ] as const)('should map tls=%s starttls=%s to %o', async (tls, starttls, expected) => {
    const options = await optionsFor({ tls, starttls });
    expect(options).toMatchObject(expected);
  });
});

describe('ConnectionManager.getSmtpTransport', () => {
  beforeEach(() => {
    smtpTransports.length = 0;
  });

  it('should build exactly one transport when 20 callers ask for the same account at once', async () => {
    const manager = new ConnectionManager([account]);
    const transports = await Promise.all(
      Array.from({ length: 20 }, async () => manager.getSmtpTransport('test')),
    );
    expect(smtpTransports).toHaveLength(1);
    expect(new Set(transports).size).toBe(1);
  });
});

describe('ConnectionManager reconnect backoff', () => {
  beforeEach(() => {
    imapInstances.length = 0;
    smtpTransports.length = 0;
    connectErrors.length = 0;
    verifyErrors.length = 0;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should close an IMAP client whose connect failed', async () => {
    connectErrors.push(new Error('Invalid credentials'));
    const manager = new ConnectionManager([account]);
    await expect(manager.getImapClient('test')).rejects.toThrow('Invalid credentials');
    expect(imapInstances[0].close).toHaveBeenCalledOnce();
  });

  it('should refuse a new IMAP connect inside the backoff window after a failure', async () => {
    connectErrors.push(new Error('Invalid credentials'));
    const manager = new ConnectionManager([account]);
    await expect(manager.getImapClient('test')).rejects.toThrow('Invalid credentials');
    vi.setSystemTime(Date.now() + 999);
    await expect(manager.getImapClient('test')).rejects.toThrow(
      'Last IMAP connect for "test" failed: Invalid credentials (next attempt in 1s)',
    );
    expect(imapInstances).toHaveLength(1);
  });

  it('should connect again once the backoff window has passed', async () => {
    connectErrors.push(new Error('Invalid credentials'));
    const manager = new ConnectionManager([account]);
    await expect(manager.getImapClient('test')).rejects.toThrow('Invalid credentials');
    vi.setSystemTime(Date.now() + 1_000);
    const client = await manager.getImapClient('test');
    expect(client).toBe(imapInstances[1]);
  });

  it('should close an SMTP transport whose verify failed and back off the next attempt', async () => {
    verifyErrors.push(new Error('535 Authentication failed'));
    const manager = new ConnectionManager([account]);
    await expect(manager.getSmtpTransport('test')).rejects.toThrow('535');
    expect(smtpTransports[0].close).toHaveBeenCalledOnce();
    await expect(manager.getSmtpTransport('test')).rejects.toThrow(
      'Last SMTP connect for "test" failed: 535 Authentication failed',
    );
    expect(smtpTransports).toHaveLength(1);
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
