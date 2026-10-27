/**
 * The real entrypoint, so the count is proven to come from a server start and
 * not from a CLI command. The collector is a loopback listener; the child gets
 * only the variables listed here, never the runner's VITEST or CI.
 */

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
}

async function collector(): Promise<Collector> {
  const bodies: unknown[] = [];
  let posted: () => void = () => {};
  const firstPost = new Promise<void>((resolve) => {
    posted = resolve;
  });
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
    });
    req.on('end', () => {
      bodies.push({ method: req.method, path: req.url, body: JSON.parse(text) as unknown });
      res.writeHead(204).end();
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
  return { url: `http://127.0.0.1:${port}/install`, bodies, firstPost };
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

async function startMailoo(
  args: string[],
  counterUrl: string,
  config = CONFIG,
): Promise<ChildProcess> {
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
  return child;
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
      const child = await startMailoo(['stdio'], sink.url);
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
      const port = await freePort();
      const child = await startMailoo(['http', String(port), '127.0.0.1'], sink.url);
      await sink.firstPost;
      expect(child.exitCode).toBeNull();
      expect(sink.bodies).toEqual([EXPECTED_POST]);
    },
    ENTRYPOINT_TEST_MS,
  );

  it.each([[['account', 'list']], [['--version']]])(
    'should not post from the %j command when opted in',
    async (args) => {
      const sink = await collector();
      const child = await startMailoo(args, sink.url);
      expect(await exitCode(child)).toBe(0);
      expect(sink.bodies).toEqual([]);
    },
    ENTRYPOINT_TEST_MS,
  );

  it.each(['stdio', 'http'])(
    'should not post when the %s server fails to load its config',
    async (mode) => {
      const sink = await collector();
      const args = mode === 'http' ? ['http', String(await freePort()), '127.0.0.1'] : [mode];
      const child = await startMailoo(args, sink.url, '[[accounts]\nname = ');
      expect(await exitCode(child)).not.toBe(0);
      expect(sink.bodies).toEqual([]);
    },
    ENTRYPOINT_TEST_MS,
  );
});
