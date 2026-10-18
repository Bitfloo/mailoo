import fs from 'node:fs/promises';
import path from 'node:path';

import {
  fakeLaunchctl,
  lineSink,
  recordRunner,
  withPlistPath,
} from '../test-support/scheduler-cli.js';
import { runUninstall } from '../test-support/scheduler-home.js';
import { buildCronLine } from './scheduler-install.js';

const INSTALLED_CRONTAB = `0 0 * * * /usr/bin/true\n${buildCronLine('/usr/bin/node', '/opt/mailoo/main.js')}\n`;

describe('scheduler uninstall command', () => {
  it('should remove the scheduler crontab line and say it was removed on linux', async () => {
    const { run, calls } = recordRunner(INSTALLED_CRONTAB);
    const { lines, print } = lineSink();
    await runUninstall('linux', run, print);
    expect({ lines, written: calls.find(({ args }) => args[0] === '-')?.input }).toEqual({
      lines: ['✅ Removed Linux crontab scheduler'],
      written: '0 0 * * * /usr/bin/true\n',
    });
  });

  it('should say no crontab scheduler was found when no line carries the marker', async () => {
    const { run } = recordRunner('0 0 * * * /usr/bin/true\n');
    const { lines, print } = lineSink();
    await runUninstall('linux', run, print);
    expect(lines).toEqual(['ℹ️  No crontab scheduler found']);
  });

  it('should unload the launchd agent before deleting its plist and say it was removed on darwin', async () => {
    await withPlistPath(async (plistPath) => {
      const plist = '<plist version="1.0"></plist>\n';
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, plist);
      const { run, agent, reads } = fakeLaunchctl({ loaded: plist });
      const { lines, print } = lineSink();
      await runUninstall('darwin', run, print, plistPath);
      const left = await fs.access(plistPath).then(
        () => true,
        () => false,
      );
      expect({ reads, loaded: agent.loaded, left, lines }).toEqual({
        reads: [{ subcommand: 'unload', plist }],
        loaded: undefined,
        left: false,
        lines: ['✅ Removed macOS launchd scheduler'],
      });
    });
  });

  it('should keep the plist and report nothing removed when launchctl cannot run on darwin', async () => {
    await withPlistPath(async (plistPath) => {
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, '<plist version="1.0"></plist>\n');
      const run = (): string => {
        throw Object.assign(new Error('spawnSync launchctl ENOENT'), { code: 'ENOENT' });
      };
      const { lines, print } = lineSink();
      const outcome = await runUninstall('darwin', run, print, plistPath).then(
        () => 'resolved',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      const left = await fs.access(plistPath).then(
        () => true,
        () => false,
      );
      expect({ outcome, left, lines }).toEqual({
        outcome: 'spawnSync launchctl ENOENT',
        left: true,
        lines: [],
      });
    });
  });

  it('should say no launchd scheduler was found when the agent is neither loaded nor installed', async () => {
    await withPlistPath(async (plistPath) => {
      const { lines, print } = lineSink();
      await runUninstall('darwin', fakeLaunchctl().run, print, plistPath);
      expect(lines).toEqual(['ℹ️  No launchd scheduler found']);
    });
  });

  it('should remove nothing and name the platform on an unsupported platform', async () => {
    const { run, calls } = recordRunner();
    const { lines, print } = lineSink();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runUninstall('win32', run, print);
      expect({ calls, lines, stderr: stderr.mock.calls.flat() }).toEqual({
        calls: [],
        lines: [],
        stderr: ['❌ Unsupported platform: win32'],
      });
    } finally {
      stderr.mockRestore();
    }
  });
});
