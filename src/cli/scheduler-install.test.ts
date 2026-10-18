import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SCHEDULER_INTERVAL_MS } from '../services/scheduler.service.js';
import { runInstall } from './scheduler.js';
import type { CommandRunner } from './scheduler-install.js';
import {
  buildCronLine,
  buildLaunchdPlist,
  CHECK_INTERVAL_SECONDS,
  installCrontabLine,
  loadLaunchAgent,
  removeCrontabLine,
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

function recordRunner(crontab = '0 0 * * * /usr/bin/true\n'): {
  run: CommandRunner;
  calls: { file: string; args: string[]; input?: string }[];
} {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const run: CommandRunner = (file, args, input) => {
    calls.push({ file, args: [...args], input });
    if (file === 'crontab' && args[0] === '-l') return crontab;
    return '';
  };
  return { run, calls };
}

function lineSink(): { lines: string[]; print: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    print: (line) => {
      lines.push(line);
    },
  };
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// A mocked execFileSync keeps every call, so the next test reads the previous stdio mode.
async function withFakeCrontab(
  list: { stdout: string } | { stderr: string },
  run: (written: () => Promise<string | undefined>) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-crontab-'));
  const stdoutPath = path.join(dir, 'stdout');
  const stderrPath = path.join(dir, 'stderr');
  const writtenPath = path.join(dir, 'written');
  const bin = path.join(dir, 'crontab');
  if ('stderr' in list) await fs.writeFile(stderrPath, list.stderr);
  else await fs.writeFile(stdoutPath, list.stdout);
  const script = `#!/bin/sh
set -e
if [ "$1" = "-l" ]; then
  if [ -f ${shQuote(stderrPath)} ]; then
    cat ${shQuote(stderrPath)} >&2
    exit 1
  fi
  cat ${shQuote(stdoutPath)}
  exit 0
fi
if [ "$1" = "-" ]; then
  cat > ${shQuote(writtenPath)}
  exit 0
fi
exit 2
`;
  await fs.writeFile(bin, script, { mode: 0o755 });
  await fs.chmod(bin, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = [dir, '/bin', '/usr/bin'].join(path.delimiter);
  try {
    await run(async () => {
      try {
        await fs.access(writtenPath);
      } catch {
        return undefined;
      }
      return fs.readFile(writtenPath, 'utf8');
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fs.rm(dir, { recursive: true, force: true });
  }
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

  it('should write crontab through stdin arguments', () => {
    const { run, calls } = recordRunner();
    const line =
      "* * * * * '/usr/bin/node' '/opt/mailoo/main.js' scheduler check # mailoo scheduler";
    installCrontabLine(line, '# mailoo scheduler', run);
    expect(calls[0]).toEqual({ file: 'crontab', args: ['-l'], input: undefined });
    expect(calls[1]?.file).toBe('crontab');
    expect(calls[1]?.args).toEqual(['-']);
    expect(calls[1]?.input).toContain(line);
    expect(calls[1]?.input).not.toMatch(/\|/);
  });

  it('should remove a crontab entry through stdin arguments', () => {
    const { run, calls } = recordRunner();
    removeCrontabLine('# mailoo scheduler', run);
    expect(calls[1]?.args).toEqual(['-']);
    expect(calls[1]?.input).toBe('0 0 * * * /usr/bin/true\n');
    expect(calls[1]?.input).not.toContain('mailoo scheduler');
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

  it.runIf(process.platform !== 'win32')(
    'should install one crontab line when the user has no crontab',
    async () => {
      const line =
        "* * * * * '/usr/bin/node' '/opt/mailoo/main.js' scheduler check # mailoo scheduler";
      await withFakeCrontab({ stderr: 'crontab: no crontab for user\n' }, async (written) => {
        expect(installCrontabLine(line, '# mailoo scheduler')).toBe(true);
        expect(await written()).toBe(`${line}\n`);
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'should not write the crontab when the marker line is already installed',
    async () => {
      const existing = '0 0 * * * /usr/bin/true\n* * * * * /opt/mailoo check # mailoo scheduler\n';
      const line =
        "* * * * * '/usr/bin/node' '/opt/mailoo/main.js' scheduler check # mailoo scheduler";
      await withFakeCrontab({ stdout: existing }, async (written) => {
        expect(installCrontabLine(line, '# mailoo scheduler')).toBe(false);
        expect(await written()).toBeUndefined();
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'should abort crontab install when listing fails for another reason',
    async () => {
      await withFakeCrontab({ stderr: 'crontab: permission denied\n' }, async (written) => {
        expect(() =>
          installCrontabLine('* * * * * /usr/bin/true # mailoo scheduler', '# mailoo scheduler'),
        ).toThrow(/permission denied/);
        expect(await written()).toBeUndefined();
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'should keep blank lines when removing a crontab entry',
    async () => {
      const existing = [
        '0 0 * * * /usr/bin/true',
        '',
        '* * * * * /opt/mailoo check # mailoo scheduler',
        '',
        '30 1 * * * /usr/bin/true',
        '',
      ].join('\n');
      await withFakeCrontab({ stdout: existing }, async (written) => {
        expect(removeCrontabLine('# mailoo scheduler')).toBe(true);
        expect(await written()).toBe('0 0 * * * /usr/bin/true\n\n\n30 1 * * * /usr/bin/true\n');
      });
    },
  );
});
