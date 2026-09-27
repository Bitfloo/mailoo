/**
 * HTTP sessions share account state (L3: queue, rate limit, watcher, hooks)
 * and only the MCP session is per client (L2: sampling target).
 * XDG_STATE_HOME is pinned before the queue path is imported.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

import type { IConnectionManager } from '../connections/types.js';
import type ImapService from '../services/imap.service.js';
import type { AccountConfig, AppConfig, EmailMeta, HookRule } from '../types/index.js';

const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-http-scope-'));
vi.stubEnv('XDG_STATE_HOME', stateHome);

const { flows } = vi.hoisted(() => ({
  flows: [] as {
    handlers: Record<string, (data: { path: string; count: number; prevCount: number }) => void>;
  }[],
}));

vi.mock('imapflow', () => {
  class MockImapFlow {
    usable = true;

    mailbox = { uidNext: 5 };

    handlers: Record<string, (data: { path: string; count: number; prevCount: number }) => void> =
      {};

    connect = vi.fn(async () => undefined);

    logout = vi.fn(async () => undefined);

    getMailboxLock = vi.fn(async () => ({ release: () => undefined }));

    on = (
      event: string,
      handler: (data: { path: string; count: number; prevCount: number }) => void,
    ) => {
      this.handlers[event] = handler;
    };

    // uidNext 5 → last seen 4, so uid 5 is one new message.
    fetch = async function* fetchNew(this: MockImapFlow) {
      yield {
        uid: this.mailbox.uidNext,
        flags: new Set<string>(),
        envelope: {
          subject: 'Hello',
          from: [{ address: 'alice@example.com' }],
          to: [{ address: 'me@example.com' }],
          date: new Date('2026-09-21T00:00:00.000Z'),
        },
      };
    };

    constructor() {
      flows.push(this);
    }
  }
  return { ImapFlow: MockImapFlow };
});

const { SCHEDULED_DIR } = await import('../config/xdg.js');
const { default: ConnectionManager } = await import('../connections/manager.js');
const { resolveHttpListen, startGuardedHttpServers } = await import('./http-transport.js');
const { createHttpMcpHost } = await import('./http-mcp-host.js');
const { httpSessionQueueDir } = await import('./http-session-scope.js');
const { default: CalendarService } = await import('../services/calendar.service.js');
const { default: ImapServiceClass } = await import('../services/imap.service.js');
const { default: LocalCalendarService } = await import('../services/local-calendar.service.js');
const { default: RemindersService } = await import('../services/reminders.service.js');
const { default: TemplateService } = await import('../services/template.service.js');

const alerts = {
  desktop: false,
  sound: false,
  urgencyThreshold: 'high' as const,
  webhookUrl: '',
  webhookEvents: ['urgent' as const],
};

function account(): AccountConfig {
  return {
    name: 'personal',
    email: 'me@example.com',
    username: 'me@example.com',
    password: 'password',
    imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
  };
}

function testConfig(overrides: {
  rateLimit?: number;
  readOnly?: boolean;
  watcherEnabled?: boolean;
  onNewEmail?: 'triage' | 'notify' | 'none';
  rules?: HookRule[];
  accounts?: AccountConfig[];
}): AppConfig {
  return {
    settings: {
      rateLimit: overrides.rateLimit ?? 2,
      readOnly: overrides.readOnly ?? true,
      saveToSent: false,
      watcher: {
        enabled: overrides.watcherEnabled ?? false,
        folders: ['INBOX'],
        idleTimeout: 1740,
      },
      systemOne: {
        enabled: false,
        model: 'jev-latest',
        includeBody: false,
        bodyMaxChars: 6000,
        autoMove: false,
        autoFlag: false,
        folders: [],
        sourceFolders: ['INBOX'],
        thresholds: {
          folderFitMin: 0.85,
          spamHigh: 0.72,
          spamUncertainLow: 0.4,
          spamUncertainHigh: 0.6,
          injectionHigh: 0.75,
          importanceFlagMin: 3,
          importanceMinConfidence: 0.7,
          isCriticalMin: 0.85,
        },
      },
      hooks: {
        onNewEmail: overrides.onNewEmail ?? 'notify',
        preset: 'priority-focus',
        autoLabel: false,
        autoFlag: false,
        batchDelay: 0,
        rules: overrides.rules ?? [],
        alerts,
      },
    },
    accounts: overrides.accounts ?? [],
  };
}

function meta(overrides: Partial<EmailMeta> = {}): EmailMeta {
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
    ...overrides,
  };
}

function mockImap(): ImapService & {
  addLabel: ReturnType<typeof vi.fn>;
  saveDraft: ReturnType<typeof vi.fn>;
} {
  return {
    saveDraft: vi.fn().mockRejectedValue(new Error('draft unavailable')),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
    setFlags: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
  } as unknown as ImapService & {
    addLabel: ReturnType<typeof vi.fn>;
    saveDraft: ReturnType<typeof vi.fn>;
  };
}

interface RunningHost {
  host: Awaited<ReturnType<typeof createHttpMcpHost>>;
  port: number;
  close: () => Promise<void>;
}

const running: RunningHost[] = [];

async function startHost(
  config: AppConfig,
  imap: ImapService = new ImapServiceClass(new ConnectionManager([])),
  connections?: IConnectionManager,
): Promise<RunningHost> {
  const manager = connections ?? new ConnectionManager(config.accounts);
  const root = await fs.mkdtemp(path.join(stateHome, 'host-'));
  const host = await createHttpMcpHost({
    config,
    connections: manager as InstanceType<typeof ConnectionManager>,
    imap,
    templateService: new TemplateService(path.join(root, 'templates')),
    calendarService: new CalendarService(),
    localCalendarService: new LocalCalendarService(),
    remindersService: new RemindersService(),
    bodyLimitBytes: 1024 * 1024,
    ttlMs: 60_000,
    now: () => 1_000,
  });
  const listener = await startGuardedHttpServers(
    resolveHttpListen({ port: 0, host: '127.0.0.1' }),
    host.handle,
  );
  const session: RunningHost = {
    host,
    port: listener.port,
    close: async () => {
      await host.close();
      await listener.close();
    },
  };
  running.push(session);
  return session;
}

async function post(
  port: number,
  body: string,
  sessionId?: string,
): Promise<{ status: number; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          const header = res.headers['mcp-session-id'];
          const id = Array.isArray(header) ? (header[0] ?? '') : (header ?? '');
          resolve({ status: res.statusCode ?? 0, sessionId: id });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function initializeBody(id: number, sampling: boolean): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: sampling ? { sampling: {} } : {},
      clientInfo: { name: 'mailoo-session-test', version: '0.0.0' },
    },
  });
}

async function openSession(session: RunningHost, id: number, sampling: boolean): Promise<string> {
  const initialized = await post(session.port, initializeBody(id, sampling));
  expect(initialized.status).toBe(200);
  expect(initialized.sessionId).not.toBe('');
  const noted = await post(
    session.port,
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    initialized.sessionId,
  );
  expect(noted.status).toBeLessThan(300);
  return initialized.sessionId;
}

async function deleteSession(session: RunningHost, sessionId: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: session.port,
        method: 'DELETE',
        path: '/mcp',
        headers: {
          host: `127.0.0.1:${session.port}`,
          'mcp-session-id': sessionId,
          accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP session account state', () => {
  afterEach(async () => {
    await Promise.all(running.splice(0).map(async (session) => session.close()));
    flows.splice(0);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateHome, { recursive: true, force: true });
  });

  it('should keep scheduled mail in SCHEDULED_DIR after the session that wrote it is disposed', async () => {
    const imap = mockImap();
    const session = await startHost(testConfig({}), imap);
    const sid = await openSession(session, 1, false);
    const scope = session.host.scopeFor(sid);
    if (!scope) throw new Error('missing session');
    const sendAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const scheduled = await scope.scheduler.schedule('personal', {
      to: ['a@example.com'],
      subject: 'tomorrow',
      body: 'still queued',
      sendAt,
    });

    expect(await deleteSession(session, sid)).toBeLessThan(300);
    // DELETE starts dispose without waiting; join it so a queued directory removal is visible.
    await scope.dispose();
    const queueFile = path.join(SCHEDULED_DIR, `${scheduled.id}.json`);
    expect(JSON.parse(await fs.readFile(queueFile, 'utf8'))).toMatchObject({
      id: scheduled.id,
      subject: 'tomorrow',
      status: 'pending',
    });
    expect((await scope.scheduler.list({ status: 'pending' })).map((item) => item.subject)).toEqual(
      ['tomorrow'],
    );
  });

  it('should refuse the (N+1)th send across two sessions when the account rate limit is N', async () => {
    const rateLimit = 2;
    const config = testConfig({ rateLimit, accounts: [account()], readOnly: false });
    const connections = new ConnectionManager(config.accounts);
    vi.spyOn(connections, 'getSmtpTransport').mockResolvedValue({
      sendMail: async () => ({ messageId: '<sent@example.com>' }),
    } as never);
    const session = await startHost(config, new ImapServiceClass(connections), connections);
    const sidA = await openSession(session, 1, false);
    const sidB = await openSession(session, 2, false);
    const scopeA = session.host.scopeFor(sidA);
    const scopeB = session.host.scopeFor(sidB);
    if (!scopeA || !scopeB) throw new Error('missing session');
    const message = {
      to: ['a@example.com'],
      subject: 'hello',
      body: 'body',
    };

    await expect(scopeA.smtp.sendEmail('personal', message)).resolves.toMatchObject({
      status: 'sent',
    });
    await expect(scopeB.smtp.sendEmail('personal', message)).resolves.toMatchObject({
      status: 'sent',
    });
    await expect(scopeA.smtp.sendEmail('personal', message)).rejects.toThrow(/Rate limit exceeded/);
  });

  it('should start one watcher per account and dispatch hooks once for two sessions', async () => {
    const imap = mockImap();
    const config = testConfig({
      readOnly: false,
      watcherEnabled: true,
      accounts: [account()],
      rules: [
        {
          name: 'from-alice',
          match: { from: 'alice@example.com' },
          actions: { labels: ['in'] },
        },
      ],
    });
    const session = await startHost(config, imap);
    await openSession(session, 1, false);
    await openSession(session, 2, false);
    await session.host.ready;
    // A second session that starts its own watcher does so before the handshake returns.
    expect(flows).toHaveLength(1);

    const exists = flows[0]?.handlers.exists;
    if (!exists) throw new Error('watcher did not register IDLE');
    exists({ path: 'INBOX', count: 2, prevCount: 1 });
    await vi.waitFor(() => {
      expect(imap.addLabel).toHaveBeenCalledTimes(1);
    });
  });

  it('should sample on the latest live sampling session and keep static rules after it closes', async () => {
    const imap = mockImap();
    const sampled: Server[] = [];
    vi.spyOn(Server.prototype, 'createMessage').mockImplementation(async function recordSample(
      this: Server,
    ) {
      sampled.push(this);
      return {
        model: 'fast',
        role: 'assistant',
        content: { type: 'text', text: '[]' },
      } as Awaited<ReturnType<Server['createMessage']>>;
    });

    const config = testConfig({
      readOnly: false,
      onNewEmail: 'triage',
      rules: [
        {
          name: 'ruled',
          match: { subject: 'ruled' },
          actions: { labels: ['kept'] },
        },
      ],
    });
    const session = await startHost(config, imap);
    const sidA = await openSession(session, 1, true);
    const sidB = await openSession(session, 2, false);
    const scopeA = session.host.scopeFor(sidA);
    const scopeB = session.host.scopeFor(sidB);
    if (!scopeA || !scopeB) throw new Error('missing session');
    await session.host.ready;

    scopeA.events.emit('email:new', {
      account: 'personal',
      mailbox: 'INBOX',
      emails: [meta({ id: '1', subject: 'needs-ai' })],
    });
    await vi.waitFor(() => {
      expect(sampled).toEqual([scopeA.server]);
    });
    expect(sampled).not.toContain(scopeB.server);

    const callsToA = () => sampled.filter((server) => server === scopeA.server).length;
    const beforeDispose = callsToA();
    expect(await deleteSession(session, sidA)).toBeLessThan(300);

    scopeB.events.emit('email:new', {
      account: 'personal',
      mailbox: 'INBOX',
      emails: [meta({ id: '2', subject: 'ruled' }), meta({ id: '3', subject: 'needs-ai' })],
    });
    await vi.waitFor(() => {
      expect(imap.addLabel).toHaveBeenCalledWith('personal', '2', 'INBOX', 'kept');
    });
    expect(callsToA()).toBe(beforeDispose);
    expect(sampled.filter((server) => server === scopeA.server)).toHaveLength(1);
  });

  it('should not register an EmailEventBus listener for an HTTP session', async () => {
    const session = await startHost(testConfig({ readOnly: true }));
    const sidA = await openSession(session, 1, false);
    const scopeA = session.host.scopeFor(sidA);
    if (!scopeA) throw new Error('missing session');
    const baseline = scopeA.events.listenerCount('email:new');
    await openSession(session, 2, false);
    expect(scopeA.events.listenerCount('email:new')).toBe(baseline);
  });

  it('should refuse a session id that leaves the queue root', () => {
    const root = path.join(stateHome, 'ids');
    expect(() => httpSessionQueueDir(root, '../outside')).toThrow(/session id/i);
    const id = randomUUID();
    const dir = httpSessionQueueDir(root, id);
    expect(dir.startsWith(path.resolve(root))).toBe(true);
    expect(path.basename(dir)).toBe(id);
  });
});
