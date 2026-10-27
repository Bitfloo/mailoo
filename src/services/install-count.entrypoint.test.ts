/**
 * The real entrypoint, so the count is proven to come from a server start and
 * not from a CLI command. The collector is a loopback listener; the child gets
 * only the variables listed here, never the runner's VITEST or CI.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

/** Test-only preload: the child's fetch ignores the count's abort signal (see the file). */
const FETCH_WITHOUT_ABORT = new URL('../test-support/fetch-without-abort.ts', import.meta.url).href;

async function startMailoo(
  args: string[],
  counterUrl: string,
  config = CONFIG,
  preload: string[] = [],
): Promise<Started> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailoo-install-entry-'));
  const configHome = path.join(root, 'config');
  await mkdir(path.join(configHome, 'mailoo'), { recursive: true });
  const configPath = path.join(configHome, 'mailoo', 'config.toml');
  await writeFile(configPath, config);
  await chmod(configPath, 0o600);
  const imports = preload.flatMap((url) => ['--import', url]);
  const child = spawn(process.execPath, ['--import', 'tsx', ...imports, 'src/main.ts', ...args], {
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
async function startHttpMailoo(
  counterUrl: string,
  preload: string[] = [],
  attemptsLeft = 3,
): Promise<ChildProcess> {
  const port = await freePort();
  const { child } = await startMailoo(
    ['http', String(port), '127.0.0.1'],
    counterUrl,
    CONFIG,
    preload,
  );
  let stderr = '';
  const outcome = await new Promise<'listening' | 'exited'>((resolve) => {
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.includes('listening on')) resolve('listening');
    });
    child.once('exit', () => resolve('exited'));
  });
  const portTaken = outcome === 'exited' && stderr.includes('EADDRINUSE');
  return portTaken && attemptsLeft > 1
    ? startHttpMailoo(counterUrl, preload, attemptsLeft - 1)
    : child;
}

async function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
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

/** Resolves with sink.pending() when stdout first contains `text`, or false if the child exits first. */
async function onStdout(child: ChildProcess, text: string, sink: Collector): Promise<boolean> {
  let stdout = '';
  return new Promise((resolve) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes(text)) resolve(sink.pending());
    });
    child.once('exit', () => resolve(false));
  });
}

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'install-count-test', version: '0.0.0' },
  },
})}\n`;

const INITIALIZED = `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`;

/** read_only: the session work after `initialized` starts no hooks, watcher or scheduler. */
const READ_ONLY_CONFIG = `[settings]\nread_only = true\n${CONFIG}`;

/** Ways a stdio server is told to stop; each must work while the count waits. */
const STDIO_STOPS: [string, (child: ChildProcess) => void][] = [
  ['SIGINT', (child) => child.kill('SIGINT')],
  ['SIGTERM', (child) => child.kill('SIGTERM')],
  ['SIGHUP', (child) => child.kill('SIGHUP')],
  ['stdin closed', (child) => child.stdin?.end()],
];

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

/** The two server starts, the only commands that count. */
const SERVER_COMMANDS = ['stdio', 'http'];

/** CLI commands that run offline and without side effects outside the test's temp HOME. */
const CLI_COMMANDS: [string, string[]][] = [
  ['account', ['account', 'list']],
  ['--version', ['--version']],
  ['-v', ['-v']],
  ['help', ['help']],
  ['--help', ['--help']],
  ['-h', ['-h']],
];

/**
 * Not run here: setup is an interactive wizard, test probes live mail servers, install and
 * scheduler change the OS, notify sends a desktop notification, config writes the user's
 * config. They are covered by the source check that only runServer and runHttpServer call
 * noteInstall.
 */
const CLI_NOT_RUN = ['setup', 'test', 'config', 'install', 'scheduler', 'notify'];

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

  it('should cover every command label of main()', async () => {
    // A new command label fails here until it is listed below as a server, run, or not run.
    const main = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    const body = main.slice(main.indexOf('async function main()'));
    const labels = [...body.matchAll(/^\s+case '([^']+)':/gm)].map((m) => m[1]);
    expect([...labels].sort()).toEqual(
      [...SERVER_COMMANDS, ...CLI_COMMANDS.map(([label]) => label), ...CLI_NOT_RUN].sort(),
    );
  });

  it.each(CLI_COMMANDS)(
    'should not post or create the install-count file from the %s command when opted in',
    async (_label, args) => {
      const sink = await collector();
      const { child, marker } = await startMailoo(args, sink.url);
      await exitCode(child);
      expect(sink.bodies).toEqual([]);
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    },
    ENTRYPOINT_TEST_MS,
  );

  it(
    'should not post from an unknown command when opted in',
    async () => {
      const sink = await collector();
      const { child, marker } = await startMailoo(['no-such-command'], sink.url);
      expect(await exitCode(child)).not.toBe(0);
      expect(sink.bodies).toEqual([]);
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
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
    'should answer on stdio while the collector still holds the count request',
    async () => {
      // The count runs after the transport is connected: a stalled collector cannot delay the server.
      // The child's fetch ignores the count's abort (test-only preload), so the held request stays
      // open until release() and no clock decides the result. A count before connect never answers.
      const sink = await collector(true);
      const { child } = await startMailoo(['stdio'], sink.url, CONFIG, [FETCH_WITHOUT_ABORT]);
      const answered = onStdout(child, '"id":1', sink);
      await sink.firstPost;
      child.stdin?.write(INITIALIZE);
      expect(await answered).toBe(true);
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

  it(
    'should start the session work after initialized while the collector still holds the count request',
    async () => {
      // The `initialized` handler is in place before the count: "Mailoo started" is logged after it.
      const sink = await collector(true);
      const { child } = await startMailoo(['stdio'], sink.url, READ_ONLY_CONFIG, [
        FETCH_WITHOUT_ABORT,
      ]);
      const answered = onStdout(child, '"id":1', sink);
      const started = onStdout(child, 'Mailoo started', sink);
      await sink.firstPost;
      child.stdin?.write(INITIALIZE);
      expect(await answered).toBe(true);
      child.stdin?.write(INITIALIZED);
      expect(await started).toBe(true);
      sink.release();
      child.stdin?.end();
      await exitCode(child);
    },
    ENTRYPOINT_TEST_MS,
  );

  it.each(STDIO_STOPS)(
    'should shut the stdio server down on %s while the collector still holds the count request',
    async (_name, stop) => {
      // The shutdown handlers are in place before the count. Nothing releases the request,
      // so an exit that waited for the count would never come.
      const sink = await collector(true);
      const { child } = await startMailoo(['stdio'], sink.url, CONFIG, [FETCH_WITHOUT_ABORT]);
      await sink.firstPost;
      expect(sink.pending()).toBe(true);
      stop(child);
      expect(await exitOf(child)).toEqual({ code: 0, signal: null });
    },
    ENTRYPOINT_TEST_MS,
  );

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'should shut the http server down on %s while the collector still holds the count request',
    async (signal) => {
      const sink = await collector(true);
      const child = await startHttpMailoo(sink.url, [FETCH_WITHOUT_ABORT]);
      expect(child.exitCode).toBeNull();
      await sink.firstPost;
      expect(sink.pending()).toBe(true);
      child.kill(signal);
      expect(await exitOf(child)).toEqual({ code: 0, signal: null });
    },
    ENTRYPOINT_TEST_MS,
  );
});
