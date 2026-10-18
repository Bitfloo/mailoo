import fs from 'node:fs/promises';
import path from 'node:path';

import { fakeLaunchctl, lineSink, withPlistPath } from '../test-support/scheduler-cli.js';
import { home, runInstall } from '../test-support/scheduler-home.js';
import { buildLaunchdPlist } from './scheduler-install.js';

const INSTALLED = '✅ Installed macOS launchd scheduler';

function plistForThisCli(): string {
  return buildLaunchdPlist(process.execPath, process.argv[1] ?? 'mailoo');
}

describe('launchd agent install', () => {
  it('should leave the agent running the new plist when an earlier install left it loaded', async () => {
    await withPlistPath(async (plistPath) => {
      const earlier = '<plist version="1.0"><dict/></plist>\n';
      await fs.mkdir(path.dirname(plistPath), { recursive: true });
      await fs.writeFile(plistPath, earlier);
      const { run, agent, reads } = fakeLaunchctl({ loaded: earlier });
      const { lines, print } = lineSink();
      await runInstall('darwin', run, print, plistPath);
      expect({ reads, loaded: agent.loaded, first: lines[0] }).toEqual({
        reads: [
          { subcommand: 'unload', plist: plistForThisCli() },
          { subcommand: 'load', plist: plistForThisCli() },
        ],
        loaded: plistForThisCli(),
        first: INSTALLED,
      });
    });
  });

  it('should load the agent and report it installed when no agent was loaded', async () => {
    await withPlistPath(async (plistPath) => {
      const { run, agent } = fakeLaunchctl();
      const { lines, print } = lineSink();
      await runInstall('darwin', run, print, plistPath);
      expect({ loaded: agent.loaded, first: lines[0] }).toEqual({
        loaded: plistForThisCli(),
        first: INSTALLED,
      });
    });
  });

  it('should write the plist into LaunchAgents under the home directory when no plist path is given', async () => {
    const { run, agent } = fakeLaunchctl();
    await runInstall('darwin', run, () => {});
    const plistPath = path.join(
      home,
      'Library',
      'LaunchAgents',
      'com.bitfloo.mailoo.scheduler.plist',
    );
    expect({ written: await fs.readFile(plistPath, 'utf8'), loaded: agent.loaded }).toEqual({
      written: plistForThisCli(),
      loaded: plistForThisCli(),
    });
  });
});
