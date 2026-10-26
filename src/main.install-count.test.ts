/**
 * The count belongs to the stdio and http server starts and to nothing else.
 * Each test starts the real entry (src/main.ts) with an env built from
 * scratch: no CI, VITEST or NODE_ENV leaks in from the runner, HOME and the
 * XDG dirs are a tmpdir, and the collector is a loopback server in this file.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Bounds a hang only: a cold tsx start under parallel unit suites exceeded 8 s before the first request.
const SERVER_START_MS = 30_000;

// A started server posts right after setup; this is how long a missing post is waited for before it counts as absent.
const COLLECTOR_WAIT_MS = 20_000;

// The test body adds a server start, a collector wait and teardown.
const SPAWN_TEST_MS = SERVER_START_MS + COLLECTOR_WAIT_MS + 10_000;

interface Received {
  method: string | undefined;
  path: string | undefined;
  contentType: string | undefined;
  body: string;
}

interface Collector {
  url: string;
  received: Received[];
  first: Promise<Received>;
}

async function startCollector(): Promise<Collector> {
  const received: Received[] = [];
  let resolveFirst: (value: Received) => void = () => {};
  const first = new Promise<Received>((resolve) => {
    resolveFirst = resolve;
  });
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const item: Received = {
        method: req.method,
        path: req.url,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(item);
      resolveFirst(item);
      res.statusCode = 204;
      res.end();
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
  return { url: `http://127.0.0.1:${port}/install`, received, first };
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

interface Started {
  child: ChildProcess;
  output: () => string;
  stateHome: string;
  exited: Promise<number | null>;
}

async function startMailoo(args: string[], collectorUrl: string): Promise<Started> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailoo-install-main-'));
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  await mkdir(path.join(configHome, 'mailoo'), { recursive: true });
  const configPath = path.join(configHome, 'mailoo', 'config.toml');
  await writeFile(configPath, ENTRY_CONFIG);
  await chmod(configPath, 0o600);
  const repoRoot = fileURLToPath(new URL('../', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', ...args], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      XDG_DATA_HOME: path.join(root, 'data'),
      MAILOO_INSTALL_COUNTER: '1',
      MAILOO_INSTALL_COUNTER_URL: collectorUrl,
    },
    // stdio stays open: EOF on stdin is the server's shutdown signal.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let combined = '';
  const append = (chunk: Buffer): void => {
    combined += chunk.toString('utf8');
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  // Vitest does not cancel a timed-out test body, so a finally here would never run on that path.
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2_000);
      await exited;
      clearTimeout(killTimer);
    }
    await rm(root, { recursive: true, force: true });
  });
  return { child, output: () => combined, stateHome, exited };
}

async function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not happen within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function packageVersion(): Promise<string> {
  const manifest = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

describe('install count at the server entry', () => {
  it.each([
    ['stdio', async () => ['stdio']],
    ['http', async () => ['http', String(await freeLoopbackPort()), '127.0.0.1']],
  ] as const)(
    'should post one install count when the %s server starts',
    async (_transport, argv) => {
      const collector = await startCollector();
      const started = await startMailoo(await argv(), collector.url);
      const request = await withinMs(
        Promise.race([
          collector.first,
          started.exited.then(() => {
            throw new Error(`server exited before the count: ${started.output()}`);
          }),
        ]),
        COLLECTOR_WAIT_MS,
        'the install count',
      );
      expect(request.method).toBe('POST');
      expect(request.path).toBe('/install');
      expect(request.contentType).toBe('application/json');
      expect(JSON.parse(request.body)).toEqual({
        product: 'mailoo',
        version: await packageVersion(),
        event: 'install',
        node_major: Number(process.versions.node.split('.')[0]),
      });
    },
    SPAWN_TEST_MS,
  );

  it.each([['--version'], ['help'], ['config', 'path']])(
    'should not count a `%s` command',
    async (...args) => {
      const collector = await startCollector();
      const started = await startMailoo(args, collector.url);
      await withinMs(started.exited, SERVER_START_MS, 'the command exit');
      expect(collector.received).toHaveLength(0);
      await expect(
        stat(path.join(started.stateHome, 'mailoo', 'install-count')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
    SPAWN_TEST_MS,
  );
});
