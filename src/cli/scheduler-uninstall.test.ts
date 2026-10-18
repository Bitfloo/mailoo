import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { lineSink, recordRunner } from '../test-support/scheduler-cli.js';
import { runUninstall } from './scheduler.js';
import type { CommandRunner } from './scheduler-install.js';
import { buildCronLine } from './scheduler-install.js';

const INSTALLED_CRONTAB = `0 0 * * * /usr/bin/true\n${buildCronLine('/usr/bin/node', '/opt/mailoo/main.js')}\n`;

async function withPlistPath(body: (plistPath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-uninstall-'));
  try {
    await body(path.join(dir, 'agent.plist'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

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

  it('should unload the launchd agent, delete its plist and say it was removed on darwin', async () => {
    await withPlistPath(async (plistPath) => {
      await fs.writeFile(plistPath, '<plist version="1.0"></plist>\n');
      const { run, calls } = recordRunner();
      const { lines, print } = lineSink();
      await runUninstall('darwin', run, print, plistPath);
      const left = await fs.access(plistPath).then(
        () => true,
        () => false,
      );
      expect({ calls, left, lines }).toEqual({
        calls: [{ file: 'launchctl', args: ['unload', plistPath], input: undefined }],
        left: false,
        lines: ['✅ Removed macOS launchd scheduler'],
      });
    });
  });

  it('should say no launchd scheduler was found when the agent is neither loaded nor installed', async () => {
    await withPlistPath(async (plistPath) => {
      const run: CommandRunner = () => {
        throw new Error(`Command failed: launchctl unload ${plistPath}`);
      };
      const { lines, print } = lineSink();
      await runUninstall('darwin', run, print, plistPath);
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
