import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SCHEDULER_INTERVAL_MS } from '../services/scheduler.service.js';
import { lineSink, recordRunner, shQuote } from '../test-support/scheduler-cli.js';
import { runInstall } from './scheduler.js';
import {
  buildCronLine,
  buildLaunchdPlist,
  CHECK_INTERVAL_SECONDS,
  loadLaunchAgent,
} from './scheduler-install.js';

// launchctl refuses a plist whose elements do not close in order, and install
// would still report the agent as installed.
function unclosedTags(xml: string): string[] {
  const open: string[] = [];
  const problems: string[] = [];
  // A self-closing tag such as <true/> does not match: it leaves nothing open.
  for (const [, slash, name] of xml.matchAll(/<(\/?)([A-Za-z]+)(?:\s[^>/]*)?>/g)) {
    if (slash === '') open.push(name);
    else if (open.pop() !== name) problems.push(`</${name}>`);
  }
  return [...problems, ...open.map((name) => `<${name}>`)];
}

describe('scheduler install commands', () => {
  it('should build a well-formed plist that logs both output streams', () => {
    const plist = buildLaunchdPlist('/usr/bin/node', '/opt/mailoo/main.js');
    const logPath = (key: string) =>
      new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1];
    expect({
      unclosed: unclosedTags(plist),
      stdout: logPath('StandardOutPath'),
      stderr: logPath('StandardErrorPath'),
    }).toEqual({
      unclosed: [],
      stdout: '/tmp/mailoo-scheduler.log',
      stderr: '/tmp/mailoo-scheduler.log',
    });
  });

  it('should start the launchd agent on the interval the server checks the queue at', () => {
    const plist = buildLaunchdPlist('/usr/bin/node', '/opt/mailoo/main.js');
    const seconds = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist)?.[1];
    expect(Number(seconds) * 1000).toBe(SCHEDULER_INTERVAL_MS);
  });

  it('should run `scheduler check` with the node and CLI paths it was given', () => {
    const plist = buildLaunchdPlist('/usr/bin/node', '/opt/mailoo/main.js');
    const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
    const args = [...(program ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    const label = /<key>Label<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
    const runAtLoad = /<key>RunAtLoad<\/key>\s*<(true|false)\/>/.exec(plist)?.[1];
    // A literal label: uninstall and status find an installed agent by it.
    expect({ args, label, runAtLoad }).toEqual({
      args: ['/usr/bin/node', '/opt/mailoo/main.js', 'scheduler', 'check'],
      label: 'com.bitfloo.mailoo.scheduler',
      runAtLoad: 'true',
    });
  });

  it('should run the crontab line on the interval the server checks the queue at', () => {
    const line = buildCronLine('/usr/bin/node', '/opt/mailoo/main.js');
    // A `*/N` minute step starts again at minute 0 every hour, so it keeps an even
    // interval only when N divides 60.
    const minutes = Number(/^\*\/(\d+) \* \* \* \* /.exec(line)?.[1]);
    expect({ ms: minutes * 60_000, dividesHour: 60 % minutes === 0 }).toEqual({
      ms: SCHEDULER_INTERVAL_MS,
      dividesHour: true,
    });
  });

  it('should quote the node and CLI paths in the crontab command', () => {
    const line = buildCronLine('/usr/bin/node', "/opt/it's/main.js");
    expect(line.split(' ').slice(5).join(' ')).toBe(
      "'/usr/bin/node' '/opt/it'\\''s/main.js' scheduler check # mailoo scheduler",
    );
  });

  it('should load launchd with an argument array and an owner-only plist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-launchd-'));
    try {
      const plistPath = path.join(dir, 'agent.plist');
      const { run, calls } = recordRunner();
      await loadLaunchAgent(plistPath, '<plist version="1.0"></plist>\n', run);
      const stat = await fs.stat(plistPath);
      expect(stat.mode % 0o1000).toBe(0o600);
      expect(calls).toEqual([{ file: 'launchctl', args: ['load', plistPath], input: undefined }]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('should install a crontab line that runs this node binary on this CLI script', async () => {
    const { run, calls } = recordRunner();
    await runInstall('linux', run, () => {});
    const installed = calls[1]?.input?.split('\n')[1] ?? '';
    const cli = process.argv[1] ?? 'mailoo';
    expect(installed.split(' ').slice(5).join(' ')).toBe(
      `${shQuote(process.execPath)} ${shQuote(cli)} scheduler check # mailoo scheduler`,
    );
  });

  it('should print the installed message and the interval in seconds when the crontab has no line yet', async () => {
    const { run } = recordRunner();
    const { lines, print } = lineSink();
    await runInstall('linux', run, print);
    expect(lines).toEqual([
      '✅ Installed Linux crontab scheduler',
      `   Runs every ${CHECK_INTERVAL_SECONDS} seconds`,
    ]);
  });

  it('should leave the crontab alone and warn when the installed line is already there', async () => {
    const { run, calls } = recordRunner(
      `${buildCronLine(process.execPath, process.argv[1] ?? 'mailoo')}\n`,
    );
    const { lines, print } = lineSink();
    await runInstall('linux', run, print);
    expect({ lines, writes: calls.filter(({ args }) => args[0] === '-') }).toEqual({
      lines: ['⚠️  Scheduler crontab entry already exists'],
      writes: [],
    });
  });

  it('should write the plist for this node binary and CLI script and load it on darwin', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-launchd-'));
    try {
      const plistPath = path.join(dir, 'LaunchAgents', 'agent.plist');
      const { run, calls } = recordRunner();
      const { lines, print } = lineSink();
      await runInstall('darwin', run, print, plistPath);
      expect({ plist: await fs.readFile(plistPath, 'utf8'), calls, lines }).toEqual({
        plist: buildLaunchdPlist(process.execPath, process.argv[1] ?? 'mailoo'),
        calls: [{ file: 'launchctl', args: ['load', plistPath], input: undefined }],
        lines: [
          '✅ Installed macOS launchd scheduler',
          `   Plist: ${plistPath}`,
          `   Runs every ${CHECK_INTERVAL_SECONDS} seconds`,
        ],
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('should install nothing on an unsupported platform', async () => {
    const { run, calls } = recordRunner();
    const { lines, print } = lineSink();
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runInstall('win32', run, print);
      expect({ calls, lines, stderr: stderr.mock.calls.flat() }).toEqual({
        calls: [],
        lines: [],
        stderr: [
          '❌ Unsupported platform: win32',
          "   Manually run 'mailoo scheduler check' on a schedule.",
        ],
      });
    } finally {
      stderr.mockRestore();
    }
  });
});
