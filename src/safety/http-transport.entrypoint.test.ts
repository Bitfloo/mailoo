import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { send } from '../test-support/http-transport-harness.js';

const HTTP_ENTRY_CONFIG = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

// Bounds a hang only: under parallel unit suites the http command did not print its listening line within 8 s.
const HTTP_COMMAND_TEST_MS = 60_000;

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

async function waitForText(child: ChildProcess, text: () => string, needle: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let onData: () => void = () => {};
    let onExit: () => void = () => {};
    const detach = (): void => {
      child.stdout?.off('data', onData);
      child.stderr?.off('data', onData);
      child.off('exit', onExit);
    };
    const settle = (err?: Error): void => {
      if (settled) return;
      settled = true;
      detach();
      if (err) reject(err);
      else resolve();
    };
    onData = (): void => {
      if (text().includes(needle)) settle();
    };
    onExit = (): void => {
      if (text().includes(needle)) settle();
      else settle(new Error(`http command exited ${child.exitCode}: ${text()}`));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', onExit);
  });
}

async function childResult(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    child.once('exit', resolve);
  });
}

async function withHttpCommand(
  args: string[],
  run: (child: ChildProcess, output: () => string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailoo-http-'));
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  const dataHome = path.join(root, 'data');
  await mkdir(path.join(configHome, 'mailoo'), { recursive: true });
  const configPath = path.join(configHome, 'mailoo', 'config.toml');
  await writeFile(configPath, HTTP_ENTRY_CONFIG);
  await chmod(configPath, 0o600);
  const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', 'http', ...args], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
      XDG_DATA_HOME: dataHome,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let combined = '';
  const append = (chunk: Buffer): void => {
    combined += chunk.toString('utf8');
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 2_000);
      await exited;
      clearTimeout(killTimer);
    }
    await rm(root, { recursive: true, force: true });
  };
  // Vitest does not cancel a timed-out test body, so a finally here would never run on that path.
  onTestFinished(stop);
  await run(child, () => combined);
}

describe('HTTP entrypoint', () => {
  it(
    'rejects a disallowed Host when the http command is listening',
    async () => {
      const port = await freeLoopbackPort();
      await withHttpCommand([String(port), '127.0.0.1'], async (child, output) => {
        await waitForText(child, output, `mailoo HTTP server listening on 127.0.0.1:${port}`);
        const foreign = await send(port, { host: `rebind.example:${port}` }, { path: '/health' });
        expect(foreign.status).toBe(403);
        expect(foreign.body).toContain('Invalid Host header');
        expect(foreign.body).not.toContain('"ok":true');
      });
    },
    HTTP_COMMAND_TEST_MS,
  );

  it(
    'refuses to bind 0.0.0.0 without a bearer token when the http command starts',
    async () => {
      const port = await freeLoopbackPort();
      await withHttpCommand([String(port), '0.0.0.0'], async (child, output) => {
        const code = await childResult(child);
        expect(code).not.toBe(0);
        expect(output()).toMatch(/MCP_EMAIL_HTTP_TOKEN/);
      });
    },
    HTTP_COMMAND_TEST_MS,
  );
});
