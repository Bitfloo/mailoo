import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import queueId from '../test-support/queue-id.js';
import { lineSink } from '../test-support/scheduler-cli.js';
import type { AppConfig, ScheduledEmail } from '../types/index.js';
import type { CommandRunner } from './scheduler-install.js';

// The XDG paths are fixed when the modules load, so a status run that lost its queue
// directory reads under this temp root and never under the real state directory.
const xdgRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-cli-status-xdg-'));
vi.stubEnv('XDG_CONFIG_HOME', path.join(xdgRoot, 'config'));
vi.stubEnv('XDG_STATE_HOME', path.join(xdgRoot, 'state'));
// The env overlay replaces the config file when these are set.
vi.stubEnv('MCP_EMAIL_ADDRESS', '');
vi.stubEnv('MCP_EMAIL_IMAP_HOST', '');
vi.stubEnv('MCP_EMAIL_SMTP_HOST', '');

const { loadConfig } = await import('../config/loader.js');
const { runStatus } = await import('./scheduler.js');

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(xdgRoot, { recursive: true, force: true });
});

const CONFIG_TOML = [
  '[[accounts]]',
  'name = "work"',
  'email = "sender@example.test"',
  'password = "not-a-secret"',
  '',
  '[accounts.imap]',
  'host = "imap.example.test"',
  '',
  '[accounts.smtp]',
  'host = "smtp.example.test"',
  '',
].join('\n');

// The shape `launchctl list <label>` prints for a loaded agent.
const LAUNCHCTL_LIST = [
  '{',
  '\t"LimitLoadToSessionType" = "Aqua";',
  '\t"Label" = "com.bitfloo.mailoo.scheduler";',
  '\t"OnDemand" = true;',
  '\t"LastExitStatus" = 0;',
  '\t"PID" = 4242;',
  '\t"Program" = "/usr/local/bin/node";',
  '};',
  '',
].join('\n');

const EMPTY_QUEUE = '\n📬 Queue: 0 pending, 0 overdue';

interface StatusEnv {
  plistPath: string;
  queueDir: string;
  load: () => Promise<AppConfig>;
}

async function withStatusEnv(body: (env: StatusEnv) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-cli-status-'));
  try {
    const configPath = path.join(root, 'config.toml');
    await fs.writeFile(configPath, CONFIG_TOML);
    const queueDir = path.join(root, 'scheduled');
    await fs.mkdir(path.join(queueDir, 'sent'), { recursive: true });
    const load = async () => loadConfig(configPath);
    await body({ plistPath: path.join(root, 'agent.plist'), queueDir, load });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** A runner that prints `outputs[file]` and fails, as the real command does, when it has none. */
function outputRunner(outputs: { launchctl?: string; crontab?: string }): {
  run: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: CommandRunner = (file, args) => {
    calls.push([file, ...args]);
    const output = file === 'launchctl' || file === 'crontab' ? outputs[file] : undefined;
    if (output === undefined) throw new Error(`Command failed: ${file} ${args.join(' ')}`);
    return output;
  };
  return { run, calls };
}

describe('scheduler status command', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should print the PID launchctl reports for the loaded agent', async () => {
    await withStatusEnv(async ({ plistPath, queueDir, load }) => {
      await fs.writeFile(plistPath, '<plist version="1.0"></plist>\n');
      const { run, calls } = outputRunner({ launchctl: LAUNCHCTL_LIST });
      const { lines, print } = lineSink();
      await runStatus('darwin', run, print, plistPath, load, queueDir);
      expect({ calls, lines }).toEqual({
        calls: [['launchctl', 'list', 'com.bitfloo.mailoo.scheduler']],
        lines: [
          '✅ macOS launchd scheduler: INSTALLED',
          `   Plist: ${plistPath}`,
          '   PID: 4242',
          EMPTY_QUEUE,
        ],
      });
    });
  });

  it('should say the agent is installed but not loaded when launchctl does not list it', async () => {
    await withStatusEnv(async ({ plistPath, queueDir, load }) => {
      await fs.writeFile(plistPath, '<plist version="1.0"></plist>\n');
      const { lines, print } = lineSink();
      await runStatus('darwin', outputRunner({}).run, print, plistPath, load, queueDir);
      expect(lines).toEqual([
        '⚠️  macOS launchd scheduler: INSTALLED but not loaded',
        `   Plist: ${plistPath}`,
        EMPTY_QUEUE,
      ]);
    });
  });

  it('should say the launchd agent is not installed when its plist is missing', async () => {
    await withStatusEnv(async ({ plistPath, queueDir, load }) => {
      const { run } = outputRunner({ launchctl: LAUNCHCTL_LIST });
      const { lines, print } = lineSink();
      await runStatus('darwin', run, print, plistPath, load, queueDir);
      expect(lines).toEqual(['❌ macOS launchd scheduler: NOT INSTALLED', EMPTY_QUEUE]);
    });
  });

  it('should say the crontab scheduler is installed when a crontab line carries the marker', async () => {
    await withStatusEnv(async ({ plistPath, queueDir, load }) => {
      const crontab = '* * * * * /opt/mailoo check # mailoo scheduler\n';
      const { lines, print } = lineSink();
      await runStatus('linux', outputRunner({ crontab }).run, print, plistPath, load, queueDir);
      expect(lines).toEqual(['✅ Linux crontab scheduler: INSTALLED', EMPTY_QUEUE]);
    });
  });

  it('should say the crontab scheduler is not installed when no crontab line carries the marker', async () => {
    await withStatusEnv(async ({ plistPath, queueDir, load }) => {
      const crontab = '0 0 * * * /usr/bin/true\n';
      const { lines, print } = lineSink();
      await runStatus('linux', outputRunner({ crontab }).run, print, plistPath, load, queueDir);
      expect(lines).toEqual(['❌ Linux crontab scheduler: NOT INSTALLED', EMPTY_QUEUE]);
    });
  });

  it('should say the crontab scheduler is not installed when the crontab cannot be listed', async () => {
    await withStatusEnv(async ({ plistPath, queueDir, load }) => {
      const { lines, print } = lineSink();
      await runStatus('linux', outputRunner({}).run, print, plistPath, load, queueDir);
      expect(lines).toEqual(['❌ Linux crontab scheduler: NOT INSTALLED', EMPTY_QUEUE]);
    });
  });

  it('should count pending emails and the ones a check would send now, leaving out sending, sent and failed', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T10:00:00.000Z'));
    await withStatusEnv(async ({ plistPath, queueDir, load }) => {
      const records: [string, Partial<ScheduledEmail>][] = [
        ['', { status: 'pending', sendAt: '2030-01-01T09:00:00.000Z' }],
        ['', { status: 'pending', sendAt: 'not-a-date' }],
        ['', { status: 'pending', sendAt: '2030-01-01T11:00:00.000Z' }],
        ['', { status: 'sending', sendAt: '2030-01-01T09:00:00.000Z' }],
        ['', { status: 'failed', sendAt: '2030-01-01T09:00:00.000Z' }],
        ['sent', { status: 'sent', sendAt: '2030-01-01T09:00:00.000Z' }],
      ];
      await Promise.all(
        records.map(async ([dir, fields], index) => {
          const id = queueId(index);
          const record: ScheduledEmail = {
            id,
            account: 'work',
            to: ['recipient@example.test'],
            subject: 'Quarterly numbers',
            body: 'The figures are below.',
            html: false,
            sendAt: '2030-01-01T09:00:00.000Z',
            createdAt: '2029-12-31T09:00:00.000Z',
            status: 'pending',
            attempts: 0,
            ...fields,
          };
          await fs.writeFile(path.join(queueDir, dir, `${id}.json`), JSON.stringify(record));
        }),
      );
      const { lines, print } = lineSink();
      await runStatus('linux', outputRunner({}).run, print, plistPath, load, queueDir);
      expect(lines.at(-1)).toBe('\n📬 Queue: 3 pending, 2 overdue');
    });
  });
});
