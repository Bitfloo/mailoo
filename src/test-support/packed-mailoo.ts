import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, onTestFinished } from 'vitest';

const execute = promisify(execFile);
// Outside the checkout Corepack can select a different pnpm than packageManager pins here.
const pnpm = process.env.npm_execpath ?? 'pnpm';
// Includes a cold TypeScript build, packing, and installing the locked production dependencies.
export const PACKAGE_SETUP_MS = 120_000;

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(
    roots.map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

export default async function packMailoo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mailoo-package-journey-'));
  roots.push(root);
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const installed = path.join(root, 'installed');
  const archive = path.join(root, 'mailoo.tgz');
  await mkdir(installed);
  const commandOptions = { cwd: repo, timeout: PACKAGE_SETUP_MS, maxBuffer: 2 * 1024 * 1024 };
  await execute(pnpm, ['build'], commandOptions);
  await execute(pnpm, ['pack', '--out', archive], commandOptions);
  await execute(
    'tar',
    ['-xzf', archive, '-C', installed, '--strip-components', '1'],
    commandOptions,
  );
  // A release tarball has no lockfile. Reuse this checkout's lock to avoid testing newer dependencies.
  await copyFile(path.join(repo, 'pnpm-lock.yaml'), path.join(installed, 'pnpm-lock.yaml'));
  await copyFile(
    path.join(repo, 'pnpm-workspace.yaml'),
    path.join(installed, 'pnpm-workspace.yaml'),
  );
  try {
    await execute(
      pnpm,
      ['install', '--prod', '--offline', '--frozen-lockfile', '--ignore-scripts'],
      { ...commandOptions, cwd: installed, env: { ...process.env, CI: 'true' } },
    );
  } catch (error) {
    const failure = error as Error & { stdout?: string };
    throw new Error(`${failure.message}\n${failure.stdout ?? ''}`, { cause: error });
  }
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8')) as {
    version: string;
    bin: { mailoo: string };
  };
  const entry = path.join(installed, manifest.bin.mailoo);
  let sequence = 0;

  async function sandbox(config: string) {
    sequence += 1;
    const home = path.join(root, `client-${sequence}`);
    const configHome = path.join(home, 'config');
    const configDir = path.join(configHome, 'mailoo');
    await mkdir(configDir, { recursive: true });
    const configFile = path.join(configDir, 'config.toml');
    await writeFile(configFile, config, { mode: 0o600 });
    await chmod(configFile, 0o600);
    return {
      home,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: path.join(home, 'data'),
        XDG_STATE_HOME: path.join(home, 'state'),
      },
    };
  }

  async function connect(config: string, overrides: Record<string, string> = {}) {
    const { home, env } = await sandbox(config);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, 'stdio'],
      cwd: home,
      env: { ...env, ...overrides },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'mailoo-package-journey', version: '0.0.0' });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    onTestFinished(async () => {
      await client.close();
      await transport.close();
    });
    await client.connect(transport);
    return { client, transport, home, stderr: () => stderr };
  }

  async function cli(config: string, args: string[]) {
    const { home, env } = await sandbox(config);
    return execute(process.execPath, [entry, ...args], {
      cwd: home,
      env,
      timeout: 30_000,
    });
  }

  return { installed, version: manifest.version, connect, cli };
}
