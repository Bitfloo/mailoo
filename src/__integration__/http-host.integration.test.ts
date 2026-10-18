/**
 * What the HTTP host does outside any one session: whether read_only keeps
 * the process-wide mail writers off, whether close() stops them and finishes
 * with a stream still open, how often the scheduler runs, and its answers on
 * paths that are not the MCP endpoint.
 */

import fs from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import HooksService from '../services/hooks.service.js';
import WatcherService from '../services/watcher.service.js';
import { send } from '../test-support/http-transport-harness.js';
import { openEventStream, postInitialize, startHost, testConfig } from './helpers/http-host.js';

// The integration config already reads only, so a host that ignored
// read_only in HTTP mode would have looked the same to every other suite.
describe('HTTP host read_only', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function writersAfterBoot(readOnly: boolean): Promise<Record<string, boolean>> {
    const config = testConfig();
    config.settings.readOnly = readOnly;
    const hooksStart = vi.spyOn(HooksService.prototype, 'start');
    const running = await startHost({ now: 1_000 }, 5_000, config);
    const checkAndSend = vi.spyOn(running.host.scheduler, 'checkAndSend');
    const client = new Client({ name: 'mailoo-read-only', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
      );
      await running.host.ready;
      return {
        hooksStarted: hooksStart.mock.calls.length > 0,
        schedulerRan: checkAndSend.mock.calls.length > 0,
      };
    } finally {
      await client.close().catch(() => undefined);
      await running.stop();
    }
  }

  it('should not arm the scheduler or start the hooks when settings.readOnly is true', async () => {
    expect(await writersAfterBoot(true)).toEqual({ hooksStarted: false, schedulerRan: false });
  });

  it('should arm the scheduler and start the hooks when settings.readOnly is false', async () => {
    expect(await writersAfterBoot(false)).toEqual({ hooksStarted: true, schedulerRan: true });
  });
});

// The scheduler, hooks and watcher outlive every session; only close() stops
// them, so a closed host that skipped one would keep sending or listening.
describe('HTTP host close', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function writersAfterClose(): Promise<Record<string, number>> {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const config = testConfig();
    config.settings.readOnly = false;
    config.settings.watcher.enabled = true;
    config.settings.hooks.onNewEmail = 'notify';
    const watcherStop = vi.spyOn(WatcherService.prototype, 'stop');
    const running = await startHost({ now: 1_000 }, 5_000, config);
    const checkAndSend = vi.spyOn(running.host.scheduler, 'checkAndSend');
    const client = new Client({ name: 'mailoo-close', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
      );
      await running.host.ready;
    } finally {
      await client.close().catch(() => undefined);
      await running.stop();
    }
    const runsAtClose = checkAndSend.mock.calls.length;
    vi.advanceTimersByTime(2 * 60_000);
    return {
      schedulerRunsAfterClose: checkAndSend.mock.calls.length - runsAtClose,
      newMailListeners: running.host.events.listenerCount('email:new'),
      watcherStops: watcherStop.mock.calls.length,
    };
  }

  it('should run the scheduler no more once the host closes', async () => {
    expect((await writersAfterClose()).schedulerRunsAfterClose).toBe(0);
  });

  it('should leave no hook listening for new mail once the host closes', async () => {
    expect((await writersAfterClose()).newMailListeners).toBe(0);
  });

  it('should stop the watcher once when the host closes', async () => {
    expect((await writersAfterClose()).watcherStops).toBe(1);
  });

  // Closing with nothing left to wait for takes milliseconds; a host that left
  // the stream open would never finish, so the deadline only ends the wait.
  const CLOSE_DEADLINE_MS = 3_000;

  it('should finish closing when a client still holds an open event stream', async () => {
    const running = await startHost({ now: 1_000 }, 5_000);
    const { sessionId } = await postInitialize(running.port, 1);
    const stream = await openEventStream(running.port, sessionId);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        running.stop().then(() => 'closed'),
        new Promise<string>((resolve) => {
          deadline = setTimeout(() => resolve('hung'), CLOSE_DEADLINE_MS);
        }),
      ]);

      expect(outcome).toBe('closed');
    } finally {
      clearTimeout(deadline);
      stream.close();
    }
  });

  // close() with nothing left to wait for resolves in milliseconds; this only
  // bounds how long the test watches for an early resolve, so a slow machine
  // can make a broken host pass but cannot fail a correct one.
  const EARLY_CLOSE_WINDOW_MS = 200;

  it('should not resolve close() until a session dispose still running has finished', async () => {
    const running = await startHost({ now: 1_000 }, 5_000);
    const { sessionId } = await postInitialize(running.port, 1);
    const scope = running.host.scopeFor(sessionId);
    if (!scope) throw new Error(`no scope for session ${sessionId}`);
    let finishDispose = (): void => {};
    const disposeHeld = new Promise<void>((resolve) => {
      finishDispose = resolve;
    });
    const dispose = scope.dispose.bind(scope);
    vi.spyOn(scope, 'dispose').mockImplementation(async () => {
      await disposeHeld;
      await dispose();
    });
    let window: ReturnType<typeof setTimeout> | undefined;
    try {
      const closing = running.host.close().then(() => 'closed');
      const early = await Promise.race([
        closing,
        new Promise<string>((resolve) => {
          window = setTimeout(() => resolve('waiting'), EARLY_CLOSE_WINDOW_MS);
        }),
      ]);
      finishDispose();

      expect({ early, late: await closing }).toEqual({ early: 'waiting', late: 'closed' });
    } finally {
      clearTimeout(window);
      finishDispose();
      await running.stop();
    }
  });
});

describe('HTTP host scheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should run the scheduler again after 60 seconds and not before when the host is writable', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const config = testConfig();
    config.settings.readOnly = false;
    const running = await startHost({ now: 1_000 }, 5_000, config);
    const checkAndSend = vi
      .spyOn(running.host.scheduler, 'checkAndSend')
      .mockResolvedValue({ sent: 0, failed: 0, deferred: 0, errors: [] });
    const client = new Client({ name: 'mailoo-scheduler', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)),
      );
      await running.host.ready;
      // The loop skips a tick while the previous check runs, so the boot check settles first.
      await new Promise(setImmediate);
      const atBoot = checkAndSend.mock.calls.length;
      vi.advanceTimersByTime(59_999);
      const before = checkAndSend.mock.calls.length - atBoot;
      vi.advanceTimersByTime(1);

      expect({ before, at: checkAndSend.mock.calls.length - atBoot }).toEqual({ before: 0, at: 1 });
    } finally {
      await client.close().catch(() => undefined);
      await running.stop();
    }
  });
});

describe('HTTP host routes', () => {
  async function ask(method: string, path: string, headers: Record<string, string> = {}) {
    const running = await startHost({ now: 1_000 }, 5_000);
    try {
      const host = `127.0.0.1:${running.port}`;
      return await send(running.port, { host, ...headers }, { method, path });
    } finally {
      await running.stop();
    }
  }

  it('should answer 404 for an unknown path', async () => {
    const res = await ask('GET', '/other');

    expect({ status: res.status, body: res.body }).toEqual({ status: 404, body: 'Not Found' });
  });

  it('should answer 405 with Allow GET for POST /health', async () => {
    const res = await ask('POST', '/health', { 'content-type': 'application/json' });

    expect({ status: res.status, allow: res.headers.allow }).toEqual({ status: 405, allow: 'GET' });
  });

  it('should answer /health with ok and the package version as JSON', async () => {
    const pkg = JSON.parse(
      await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    const res = await ask('GET', '/health');

    expect({
      status: res.status,
      type: res.headers['content-type'],
      body: JSON.parse(res.body),
    }).toEqual({
      status: 200,
      type: 'application/json',
      body: { ok: true, version: pkg.version },
    });
  });
});
