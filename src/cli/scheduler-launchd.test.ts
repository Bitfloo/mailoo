import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { lineSink } from '../test-support/scheduler-cli.js';
import { runInstall } from '../test-support/scheduler-home.js';
import type { CommandRunner } from './scheduler-install.js';

// launchctl refuses to load an agent that is already loaded and to unload one that is not.
function fakeLaunchctl(
  loaded: boolean,
  loadFailure?: Error,
): { run: CommandRunner; state: { loaded: boolean }; calls: string[] } {
  const state = { loaded };
  const calls: string[] = [];
  const run: CommandRunner = (file, args) => {
    calls.push(`${file} ${args[0] ?? ''}`);
    if (args[0] === 'load') {
      if (loadFailure !== undefined) throw loadFailure;
      if (state.loaded) throw new Error(`Command failed: launchctl load ${args[1] ?? ''}`);
      state.loaded = true;
    } else if (args[0] === 'unload') {
      if (!state.loaded) throw new Error(`Command failed: launchctl unload ${args[1] ?? ''}`);
      state.loaded = false;
    }
    return '';
  };
  return { run, state, calls };
}

async function withPlistPath(body: (plistPath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-launchd-'));
  try {
    await body(path.join(dir, 'LaunchAgents', 'agent.plist'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('launchd agent install', () => {
  it('should reload the agent and report it installed when an earlier install left it loaded', async () => {
    await withPlistPath(async (plistPath) => {
      const { run, state, calls } = fakeLaunchctl(true);
      const { lines, print } = lineSink();
      await runInstall('darwin', run, print, plistPath);
      expect({ calls, loaded: state.loaded, first: lines[0] }).toEqual({
        calls: ['launchctl unload', 'launchctl load'],
        loaded: true,
        first: '✅ Installed macOS launchd scheduler',
      });
    });
  });

  it('should load the agent and report it installed when no agent was loaded', async () => {
    await withPlistPath(async (plistPath) => {
      const { run, state } = fakeLaunchctl(false);
      const { lines, print } = lineSink();
      await runInstall('darwin', run, print, plistPath);
      expect({ loaded: state.loaded, first: lines[0] }).toEqual({
        loaded: true,
        first: '✅ Installed macOS launchd scheduler',
      });
    });
  });

  it('should fail the install with the launchctl error and not report it installed when load fails', async () => {
    await withPlistPath(async (plistPath) => {
      const failure = new Error(`Command failed: launchctl load ${plistPath}`);
      const { run } = fakeLaunchctl(false, failure);
      const { lines, print } = lineSink();
      const outcome = await runInstall('darwin', run, print, plistPath).then(
        () => 'resolved',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      expect({ outcome, lines }).toEqual({ outcome: failure.message, lines: [] });
    });
  });
});
