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
  it('passes disableIMAP4rev2 through to ImapFlow', () => {
    const opts = buildImapFlowOptions(account) as {
      disableIMAP4rev2?: boolean;
      host?: string;
    };
    expect(opts.disableIMAP4rev2).toBe(true);
    expect(opts.host).toBe('imap.strato.de');
  });
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
