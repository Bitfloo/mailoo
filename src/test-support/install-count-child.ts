/**
 * Starts the real entry (src/main.ts) for the install count suites with an env
 * built from scratch: no CI, VITEST or NODE_ENV leaks in from the runner, HOME
 * and the XDG dirs are a tmpdir, and the collector is a loopback server.
 */

import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';

// Bounds a hang only: a cold tsx start under parallel unit suites exceeded 8 s before the first request.
export const SERVER_START_MS = 30_000;

// A started server posts right after setup; this is how long a missing post is waited for before it counts as absent.
export const COLLECTOR_WAIT_MS = 20_000;

// A child that ignores SIGTERM gets this long before SIGKILL.
const KILL_GRACE_MS = 2_000;

// Room for KILL_GRACE_MS and for removing the child's tmpdir.
export const TEARDOWN_MS = 10_000;

export const SPAWN_TEST_MS = SERVER_START_MS + COLLECTOR_WAIT_MS + TEARDOWN_MS;

export interface Received {
  method: string | undefined;
  path: string | undefined;
  contentType: string | undefined;
  body: string;
}

export interface Collector {
  url: string;
  received: Received[];
  first: Promise<Received>;
}

export async function startCollector(): Promise<Collector> {
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

export interface Started {
  child: ReturnType<typeof spawn>;
  output: () => string;
  stateHome: string;
  exited: Promise<number | null>;
}

/** `configToml` undefined leaves the config file absent. */
export async function startMailoo(
  args: string[],
  collectorUrl: string,
  configToml?: string,
): Promise<Started> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailoo-install-main-'));
  // Registered before anything can throw; hooks run last-in first, so the child is stopped before this.
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  await mkdir(path.join(configHome, 'mailoo'), { recursive: true });
  const configPath = path.join(configHome, 'mailoo', 'config.toml');
  if (configToml !== undefined) {
    await writeFile(configPath, configToml);
    await chmod(configPath, 0o600);
  }
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
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
      }, KILL_GRACE_MS);
      await exited;
      clearTimeout(killTimer);
    }
  });
  return { child, output: () => combined, stateHome, exited };
}

export async function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
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

export function markerPath(started: Started): string {
  return path.join(started.stateHome, 'mailoo', 'install-count');
}
