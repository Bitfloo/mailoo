/**
 * The count runs after everything a server start sets up. The collector holds the count
 * request open and the child's fetch ignores the count's abort (test-only preload), so each
 * test acts while the count is still waiting and no clock decides the result: a count placed
 * before the step under test never lets that step happen before the test releases it.
 */

import type { ChildProcess } from 'node:child_process';
import http from 'node:http';
import {
  COLLECTOR_WAIT_MS,
  SPAWN_TEST_MS,
  startMailoo,
  withinMs,
} from './test-support/install-count-child.js';

const ENTRY_CONFIG = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

/** read_only: the session work after `initialized` starts no hooks, watcher or scheduler. */
const READ_ONLY_CONFIG = `[settings]\nread_only = true\n${ENTRY_CONFIG}`;

const FETCH_WITHOUT_ABORT = new URL('./test-support/fetch-without-abort.ts', import.meta.url).href;

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'install-count-test', version: '0.0.0' },
  },
})}\n`;

const INITIALIZED = `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`;

interface HeldCollector {
  url: string;
  /** Resolves when the count request has arrived; it gets no answer until release(). */
  requested: Promise<void>;
  /** True while the request waits for its answer. */
  holding: () => boolean;
  release: () => void;
}

async function startHeldCollector(): Promise<HeldCollector> {
  let seen!: () => void;
  const requested = new Promise<void>((resolve) => {
    seen = resolve;
  });
  let waiting: http.ServerResponse | undefined;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      waiting = res;
      res.once('close', () => {
        waiting = undefined;
      });
      seen();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/install`,
    requested,
    holding: () => waiting !== undefined,
    release: () => waiting?.writeHead(204).end(),
  };
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Resolves with holding() when the child's `stream` first contains `text`; false if it exits first. */
async function whenSeen(
  child: ChildProcess,
  stream: 'stdout' | 'stderr',
  text: string,
  collector: HeldCollector,
): Promise<boolean> {
  let seen = '';
  return new Promise((resolve) => {
    child[stream]?.on('data', (chunk: Buffer) => {
      seen += chunk.toString('utf8');
      if (seen.includes(text)) resolve(collector.holding());
    });
    child.once('exit', () => resolve(false));
  });
}

async function exitOf(
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

/** An http start on a free port; the count request is held, so it never reaches its answer. */
async function startHeldHttp(collector: HeldCollector): Promise<ChildProcess> {
  const port = await freeLoopbackPort();
  const started = await startMailoo(
    ['http', String(port), '127.0.0.1'],
    collector.url,
    ENTRY_CONFIG,
    [FETCH_WITHOUT_ABORT],
  );
  return started.child;
}

describe('install count order at the server entry', () => {
  it(
    'should start the stdio session work after initialized while the count request is held',
    async () => {
      const collector = await startHeldCollector();
      const { child } = await startMailoo(['stdio'], collector.url, READ_ONLY_CONFIG, [
        FETCH_WITHOUT_ABORT,
      ]);
      const answered = whenSeen(child, 'stdout', '"id":1', collector);
      const started = whenSeen(child, 'stdout', 'Mailoo started', collector);
      await withinMs(collector.requested, COLLECTOR_WAIT_MS, 'the install count request');
      child.stdin?.write(INITIALIZE);
      await answered;
      child.stdin?.write(INITIALIZED);
      expect(await started).toBe(true);
    },
    SPAWN_TEST_MS,
  );

  it.each([
    ['SIGINT', (child: ChildProcess) => child.kill('SIGINT')],
    ['SIGTERM', (child: ChildProcess) => child.kill('SIGTERM')],
    ['SIGHUP', (child: ChildProcess) => child.kill('SIGHUP')],
    ['a closed stdin', (child: ChildProcess) => child.stdin?.end()],
  ] as const)(
    'should shut the stdio server down on %s while the count request is held',
    async (_how, stop) => {
      const collector = await startHeldCollector();
      const { child } = await startMailoo(['stdio'], collector.url, ENTRY_CONFIG, [
        FETCH_WITHOUT_ABORT,
      ]);
      await withinMs(collector.requested, COLLECTOR_WAIT_MS, 'the install count request');
      stop(child);
      expect(await exitOf(child)).toEqual({ code: 0, signal: null });
    },
    SPAWN_TEST_MS,
  );

  it(
    'should print the http listen line while the count request is held',
    async () => {
      const collector = await startHeldCollector();
      const child = await startHeldHttp(collector);
      // The listen line may come before the request; what matters is that it comes while
      // nothing will ever release the request.
      const listening = new Promise<boolean>((resolve) => {
        let seen = '';
        child.stderr?.on('data', (chunk: Buffer) => {
          seen += chunk.toString('utf8');
          if (seen.includes('listening on')) resolve(true);
        });
        child.once('exit', () => resolve(false));
      });
      await withinMs(collector.requested, COLLECTOR_WAIT_MS, 'the install count request');
      expect(await listening).toBe(true);
    },
    SPAWN_TEST_MS,
  );

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'should shut the http server down on %s while the count request is held',
    async (signal) => {
      const collector = await startHeldCollector();
      const child = await startHeldHttp(collector);
      await withinMs(collector.requested, COLLECTOR_WAIT_MS, 'the install count request');
      child.kill(signal);
      expect(await exitOf(child)).toEqual({ code: 0, signal: null });
    },
    SPAWN_TEST_MS,
  );
});
