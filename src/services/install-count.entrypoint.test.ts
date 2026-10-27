/**
 * The real entrypoint, so the count is proven to come from a server start and
 * not from a CLI command. The collector is a loopback listener; the child gets
 * only the variables listed here, never the runner's VITEST or CI.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

// Bounds a hang only: a cold tsx start under the parallel unit suite has taken over 8 s.
const ENTRYPOINT_TEST_MS = 60_000;

interface Collector {
  url: string;
  bodies: unknown[];
  firstPost: Promise<void>;
  /** With `hold`, true while the first request waits for its answer. */
  pending: () => boolean;
  /** With `hold`, true once a held request was closed by the client before release(). */
  abandoned: () => boolean;
  release: () => void;
}

/** With `hold`, the first request gets no answer until release(), so a test can act while it waits. */
async function collector(hold = false): Promise<Collector> {
  const bodies: unknown[] = [];
  let posted: () => void = () => {};
  const firstPost = new Promise<void>((resolve) => {
    posted = resolve;
  });
  let waiting: http.ServerResponse | undefined;
  let gaveUp = false;
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    req.on('end', () => {
      bodies.push({ method: req.method, path: req.url, body: JSON.parse(text) as unknown });
      if (hold) {
        waiting = res;
        res.once('close', () => {
          if (!res.writableEnded) gaveUp = true;
          waiting = undefined;
        });
      } else {
        res.writeHead(204).end();
      }
      posted();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/install`,
    bodies,
    firstPost,
    pending: () => waiting !== undefined,
    abandoned: () => gaveUp,
    release: () => waiting?.writeHead(204).end(),
  };
}

async function freePort(): Promise<number> {
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

/** A loopback port this test keeps bound until it finishes, so no other process can take it. */
async function heldPort(): Promise<number> {
  const holder = http.createServer();
  await new Promise<void>((resolve) => {
    holder.listen(0, '127.0.0.1', resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve) => {
      holder.close(() => resolve());
    });
  });
  const address = holder.address();
  return typeof address === 'object' && address ? address.port : 0;
}

/** Collects a child's stderr from the moment it is called. */
function stderrOf(child: ChildProcess): () => string {
  let text = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return () => text;
}

interface Started {
  child: ChildProcess;
  /** Where this start's install-count marker would be. */
  marker: string;
}

async function startMailoo(args: string[], counterUrl: string, config = CONFIG): Promise<Started> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailoo-install-entry-'));
  const configHome = path.join(root, 'config');
  await mkdir(path.join(configHome, 'mailoo'), { recursive: true });
  const configPath = path.join(configHome, 'mailoo', 'config.toml');
  await writeFile(configPath, config);
  await chmod(configPath, 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_DATA_HOME: path.join(root, 'data'),
      MAILOO_INSTALL_COUNTER: '1',
      MAILOO_INSTALL_COUNTER_URL: counterUrl,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  // Vitest does not cancel a timed-out test body, so a finally here would never run on that path.
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  return { child, marker: path.join(root, 'state', 'mailoo', 'install-count') };
}

/**
 * The port from freePort() can be taken before the child binds it. Only a child
 * that failed to bind (EADDRINUSE) is started again on a fresh port; any other
 * exit before the listen line is returned as is, so the caller's assertions fail.
 */
async function startHttpMailoo(counterUrl: string, attemptsLeft = 3): Promise<ChildProcess> {
  const port = await freePort();
  const { child } = await startMailoo(['http', String(port), '127.0.0.1'], counterUrl);
  let stderr = '';
  const outcome = await new Promise<'listening' | 'exited'>((resolve) => {
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.includes('listening on')) resolve('listening');
    });
    child.once('exit', () => resolve('exited'));
  });
  const portTaken = outcome === 'exited' && stderr.includes('EADDRINUSE');
  return portTaken && attemptsLeft > 1 ? startHttpMailoo(counterUrl, attemptsLeft - 1) : child;
}

async function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

// The version a server start reports is the one package.json ships.
const { version: PACKAGE_VERSION } = (
  await import('../../package.json', { with: { type: 'json' } })
).default as { version: string };

const EXPECTED_POST = {
  method: 'POST',
  path: '/install',
  body: {
    product: 'mailoo',
    version: PACKAGE_VERSION,
    event: 'install',
    node_major: Number.parseInt(process.versions.node, 10),
  },
};

describe('install count from the entrypoint', () => {
  it(
    'should post once when the opted-in stdio server starts',
    async () => {
      const sink = await collector();
      const { child } = await startMailoo(['stdio'], sink.url);
      await sink.firstPost;
      expect(child.exitCode).toBeNull();
      child.stdin?.end();
      await exitCode(child);
      expect(sink.bodies).toEqual([EXPECTED_POST]);
    },
    ENTRYPOINT_TEST_MS,
  );

  it(
    'should post once when the opted-in http server starts',
    async () => {
      const sink = await collector();
      const child = await startHttpMailoo(sink.url);
      expect(child.exitCode).toBeNull();
      await sink.firstPost;
      expect(sink.bodies).toEqual([EXPECTED_POST]);
    },
    ENTRYPOINT_TEST_MS,
  );

  it.each([[['account', 'list']], [['--version']]])(
    'should not post from the %j command when opted in',
    async (args) => {
      const sink = await collector();
      const { child } = await startMailoo(args, sink.url);
      expect(await exitCode(child)).toBe(0);
      expect(sink.bodies).toEqual([]);
    },
    ENTRYPOINT_TEST_MS,
  );

  it.each(['stdio', 'http'])(
    'should not post when the %s server fails to load its config',
    async (mode) => {
      const sink = await collector();
      // A held port: the http start fails on its config, which is read before the bind.
      const args = mode === 'http' ? ['http', String(await heldPort()), '127.0.0.1'] : [mode];
      const { child } = await startMailoo(args, sink.url, '[[accounts]\nname = ');
      const stderr = stderrOf(child);
      expect(await exitCode(child)).not.toBe(0);
      expect(stderr()).not.toContain('EADDRINUSE');
      expect(sink.bodies).toEqual([]);
    },
    ENTRYPOINT_TEST_MS,
  );

  // A start that never serves must not use up the one count of its state directory.
  it(
    'should not post when the http server cannot bind its port',
    async () => {
      const sink = await collector();
      const { child } = await startMailoo(
        ['http', String(await heldPort()), '127.0.0.1'],
        sink.url,
      );
      const stderr = stderrOf(child);
      expect(await exitCode(child)).not.toBe(0);
      expect(stderr()).toContain('EADDRINUSE');
      expect(sink.bodies).toEqual([]);
    },
    ENTRYPOINT_TEST_MS,
  );

  it(
    'should leave no install-count file when the http server cannot bind its port',
    async () => {
      const sink = await collector();
      const { child, marker } = await startMailoo(
        ['http', String(await heldPort()), '127.0.0.1'],
        sink.url,
      );
      const stderr = stderrOf(child);
      expect(await exitCode(child)).not.toBe(0);
      expect(stderr()).toContain('EADDRINUSE');
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    },
    ENTRYPOINT_TEST_MS,
  );

  it(
    'should answer on stdio while the count is still waiting for the collector',
    async () => {
      // The count runs after the transport is connected: a stalled collector cannot delay the server.
      // The child gives up a held request after its 3 s bound; an initialize answer takes milliseconds.
      const sink = await collector(true);
      const { child } = await startMailoo(['stdio'], sink.url);
      let stdout = '';
      const answered = new Promise<boolean>((resolve) => {
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (stdout.includes('"id":1')) resolve(true);
        });
        child.once('exit', () => resolve(false));
      });
      await sink.firstPost;
      expect(sink.pending()).toBe(true);
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'install-count-test', version: '0.0.0' },
          },
        })}\n`,
      );
      expect(await answered).toBe(true);
      expect(sink.abandoned()).toBe(false);
      sink.release();
      child.stdin?.end();
      await exitCode(child);
    },
    ENTRYPOINT_TEST_MS,
  );

  it(
    'should print the http listen line before the count waits for the collector',
    async () => {
      // The count runs after the server is listening: a stalled collector cannot delay the announcement.
      const sink = await collector(true);
      const child = await startHttpMailoo(sink.url);
      expect(child.exitCode).toBeNull();
      expect(sink.abandoned()).toBe(false);
      await sink.firstPost;
      sink.release();
    },
    ENTRYPOINT_TEST_MS,
  );
});
