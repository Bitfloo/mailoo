import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IConnectionManager } from '../connections/types.js';
import type ImapService from '../services/imap.service.js';
import type { EmailMeta, HooksConfig } from '../types/index.js';
import { createHttpSessionScope, httpSessionQueueDir } from './http-session-scope.js';

const alerts = {
  desktop: false,
  sound: false,
  urgencyThreshold: 'high' as const,
  webhookUrl: '',
  webhookEvents: ['urgent' as const],
};

function hooksConfig(): HooksConfig {
  return {
    onNewEmail: 'notify',
    preset: 'priority-focus',
    autoLabel: false,
    autoFlag: false,
    batchDelay: 0,
    rules: [],
    alerts,
  };
}

function meta(): EmailMeta {
  return {
    id: '10',
    subject: 'Hello',
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: 'me@example.com' }],
    date: '2026-09-21T00:00:00.000Z',
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
  };
}

function connections(): IConnectionManager {
  return {
    getAccount: () => {
      throw new Error('no account');
    },
    getAccountNames: () => [],
    getImapClient: async () => {
      throw new Error('no imap');
    },
    getSmtpTransport: async () => {
      throw new Error('no smtp');
    },
    closeAll: async () => {},
  };
}

function imap(): ImapService {
  return {
    saveDraft: async () => {
      throw new Error('no draft');
    },
    deleteEmail: async () => {},
  } as unknown as ImapService;
}

describe('HTTP session scope', () => {
  let root: string;
  const scopes: ReturnType<typeof createHttpSessionScope>[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-http-scope-'));
  });

  afterEach(async () => {
    await Promise.all(scopes.splice(0).map(async (scope) => scope.dispose()));
    await fs.rm(root, { recursive: true, force: true });
  });

  function openScope(id = randomUUID()) {
    const queueDir = path.join(root, id);
    const scope = createHttpSessionScope({
      id,
      queueDir,
      rateLimit: 2,
      saveToSent: false,
      watcher: { enabled: false, folders: ['INBOX'], idleTimeout: 1740 },
      accounts: [],
      hooks: hooksConfig(),
      connections: connections(),
      imap: imap(),
    });
    scopes.push(scope);
    return scope;
  }

  it('should keep rate-limit tokens inside the session that consumed them', () => {
    const first = openScope();
    const second = openScope();
    expect(first.rateLimiter.tryConsume('box')).toBe(true);
    expect(first.rateLimiter.tryConsume('box')).toBe(true);
    expect(first.rateLimiter.tryConsume('box')).toBe(false);
    expect(second.rateLimiter.tryConsume('box')).toBe(true);
  });

  it('should hide scheduled mail from another session', async () => {
    const first = openScope();
    const second = openScope();
    const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await first.scheduler.schedule('box', {
      to: ['a@example.com'],
      subject: 'only-first',
      body: 'hidden',
      sendAt,
    });

    expect((await first.scheduler.list({ status: 'pending' })).map((item) => item.subject)).toEqual(
      ['only-first'],
    );
    expect(await second.scheduler.list({ status: 'all' })).toEqual([]);
  });

  it('should not deliver resource updates from one session to another', async () => {
    const first = openScope();
    const second = openScope();
    const updatesA: string[] = [];
    const updatesB: string[] = [];
    const serverFor = (updates: string[]) =>
      ({
        sendResourceUpdated: async (notice: { uri: string }) => {
          updates.push(notice.uri);
        },
      }) as never;

    first.hooks.start(serverFor(updatesA), { sampling: false });
    second.hooks.start(serverFor(updatesB), { sampling: false });
    first.events.emit('email:new', {
      account: 'personal',
      mailbox: 'INBOX',
      emails: [meta()],
    });

    await vi.waitFor(() => {
      expect(updatesA).toEqual(['email://personal/unread', 'email://personal/mailboxes']);
    });
    expect(updatesB).toEqual([]);
    first.hooks.stop();
    second.hooks.stop();
  });

  it('should drop scheduled mail when the session is disposed', async () => {
    const first = openScope();
    const second = openScope();
    const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await first.scheduler.schedule('box', {
      to: ['a@example.com'],
      subject: 'gone',
      body: 'hidden',
      sendAt,
    });
    await second.scheduler.schedule('box', {
      to: ['b@example.com'],
      subject: 'stays',
      body: 'hidden',
      sendAt,
    });

    const firstDir = first.queueDir;
    await first.dispose();
    await expect(fs.access(firstDir)).rejects.toThrow();
    expect(
      (await second.scheduler.list({ status: 'pending' })).map((item) => item.subject),
    ).toEqual(['stays']);
    await second.dispose();
  });

  it('should refuse a session id that leaves the queue root', () => {
    expect(() => httpSessionQueueDir(root, '../outside')).toThrow(/session id/i);
    const id = randomUUID();
    const dir = httpSessionQueueDir(root, id);
    expect(dir.startsWith(path.resolve(root))).toBe(true);
    expect(path.basename(dir)).toBe(id);
  });
});
