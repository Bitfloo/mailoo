/**
 * CLI scheduler subcommands.
 *
 * Provides check, list, install, uninstall, and status subcommands
 * for managing the email scheduler.
 */

/* eslint-disable n/no-sync -- CLI install waits for launchctl and crontab */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../config/loader.js';
import ConnectionManager from '../connections/manager.js';
import RateLimiter from '../safety/rate-limiter.js';
import ImapService from '../services/imap.service.js';
import SchedulerService from '../services/scheduler.service.js';
import SmtpService from '../services/smtp.service.js';

const LAUNCHD_LABEL = 'com.bitfloo.mailoo.scheduler';
const LAUNCHD_PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LAUNCHD_PLIST = path.join(LAUNCHD_PLIST_DIR, `${LAUNCHD_LABEL}.plist`);
const CRONTAB_MARKER = '# mailoo scheduler';

export type CommandRunner = (file: string, args: readonly string[], input?: string) => string;

export function runCommandFile(file: string, args: readonly string[], input?: string): string {
  return execFileSync(file, [...args], {
    encoding: 'utf-8',
    stdio: input === undefined ? ['ignore', 'pipe', 'ignore'] : ['pipe', 'pipe', 'ignore'],
    ...(input === undefined ? {} : { input }),
  });
}

function quoteCronArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function readCrontab(run: CommandRunner): string {
  try {
    return run('crontab', ['-l']);
  } catch {
    return '';
  }
}

export async function loadLaunchAgent(
  plistPath: string,
  plist: string,
  run: CommandRunner = runCommandFile,
): Promise<void> {
  await fs.mkdir(path.dirname(plistPath), { recursive: true });
  await fs.writeFile(plistPath, plist, { mode: 0o600 });
  await fs.chmod(plistPath, 0o600);
  try {
    run('launchctl', ['load', plistPath]);
  } catch {
    // May already be loaded
  }
}

export function installCrontabLine(
  line: string,
  marker: string,
  run: CommandRunner = runCommandFile,
): boolean {
  const existing = readCrontab(run);
  if (existing.includes(marker)) return false;
  const body = existing.trim().length === 0 ? `${line}\n` : `${existing.trimEnd()}\n${line}\n`;
  run('crontab', ['-'], body);
  return true;
}

export function removeCrontabLine(marker: string, run: CommandRunner = runCommandFile): boolean {
  let existing: string;
  try {
    existing = run('crontab', ['-l']);
  } catch {
    return false;
  }
  const lines = existing.split('\n').filter((entry) => entry.length > 0 && !entry.includes(marker));
  run('crontab', ['-'], `${lines.join('\n')}\n`);
  return true;
}

function getExecutablePath(): string {
  return process.argv[1] ?? 'mailoo';
}

async function createSchedulerService(): Promise<SchedulerService> {
  const config = await loadConfig();
  const connections = new ConnectionManager(config.accounts);
  const rateLimiter = new RateLimiter(config.settings.rateLimit);
  const imapService = new ImapService(connections);
  const smtpService = new SmtpService(connections, rateLimiter, imapService);
  return new SchedulerService(smtpService, imapService);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runCheck(): Promise<void> {
  const scheduler = await createSchedulerService();
  const result = await scheduler.checkAndSend();

  if (result.sent > 0) {
    console.log(`✅ Sent ${result.sent} scheduled email(s)`);
  }
  if (result.failed > 0) {
    console.log(`❌ Failed: ${result.failed}`);
    for (const err of result.errors) console.log(`   ${err}`); // eslint-disable-line no-restricted-syntax
  }
  if (result.sent === 0 && result.failed === 0) {
    console.log('No overdue scheduled emails.');
  }
}

async function runList(): Promise<void> {
  const scheduler = await createSchedulerService();
  const emails = await scheduler.list({ status: 'all' });

  if (emails.length === 0) {
    console.log('No scheduled emails.');
    return;
  }

  const pending = emails.filter((e) => e.status === 'pending');
  const sent = emails.filter((e) => e.status === 'sent');
  const failed = emails.filter((e) => e.status === 'failed');

  if (pending.length > 0) {
    console.log(`\n📬 Pending (${pending.length}):`);
    pending.forEach((e) => {
      const overdue = new Date(e.sendAt).getTime() < Date.now() ? ' ⚠️ OVERDUE' : '';
      console.log(
        `  ${e.id.slice(0, 8)} | ${e.account} → ${e.to.join(', ')} | "${e.subject}" | ${e.sendAt}${overdue}`,
      );
    });
  }

  if (sent.length > 0) {
    console.log(`\n✅ Sent (${sent.length}):`);
    sent.forEach((e) => {
      console.log(
        `  ${e.id.slice(0, 8)} | ${e.account} → ${e.to.join(', ')} | "${e.subject}" | sent ${e.sentAt}`,
      );
    });
  }

  if (failed.length > 0) {
    console.log(`\n❌ Failed (${failed.length}):`);
    failed.forEach((e) => {
      console.log(
        `  ${e.id.slice(0, 8)} | ${e.account} → ${e.to.join(', ')} | "${e.subject}" | ${e.lastError}`,
      );
    });
  }
}

async function runInstall(): Promise<void> {
  const platform = os.platform();
  const execPath = getExecutablePath();

  if (platform === 'darwin') {
    // macOS: launchd plist
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${execPath}</string>
    <string>scheduler</string>
    <string>check</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>/tmp/mailoo-scheduler.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/mailoo-scheduler.log</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;

    await loadLaunchAgent(LAUNCHD_PLIST, plist);

    console.log('✅ Installed macOS launchd scheduler');
    console.log(`   Plist: ${LAUNCHD_PLIST}`);
    console.log('   Runs every 60 seconds');
  } else if (platform === 'linux') {
    // Linux: crontab
    const cronLine = `* * * * * ${quoteCronArg(process.execPath)} ${quoteCronArg(execPath)} scheduler check ${CRONTAB_MARKER}`;

    if (!installCrontabLine(cronLine, CRONTAB_MARKER)) {
      console.log('⚠️  Scheduler crontab entry already exists');
      return;
    }

    console.log('✅ Installed Linux crontab scheduler');
    console.log('   Runs every minute');
  } else {
    console.error(`❌ Unsupported platform: ${platform}`);
    console.error("   Manually run 'mailoo scheduler check' on a schedule.");
  }
}

async function runUninstall(): Promise<void> {
  const platform = os.platform();

  if (platform === 'darwin') {
    try {
      runCommandFile('launchctl', ['unload', LAUNCHD_PLIST]);
    } catch {
      // May not be loaded
    }

    try {
      await fs.unlink(LAUNCHD_PLIST);
      console.log('✅ Removed macOS launchd scheduler');
    } catch {
      console.log('ℹ️  No launchd scheduler found');
    }
  } else if (platform === 'linux') {
    if (removeCrontabLine(CRONTAB_MARKER)) {
      console.log('✅ Removed Linux crontab scheduler');
    } else {
      console.log('ℹ️  No crontab scheduler found');
    }
  } else {
    console.error(`❌ Unsupported platform: ${platform}`);
  }
}

async function runStatus(): Promise<void> {
  const platform = os.platform();

  if (platform === 'darwin') {
    try {
      await fs.access(LAUNCHD_PLIST);
      try {
        const output = runCommandFile('launchctl', ['list', LAUNCHD_LABEL]);
        const pidMatch = /"PID"\s*=\s*(\d+)/.exec(output);
        console.log('✅ macOS launchd scheduler: INSTALLED');
        console.log(`   Plist: ${LAUNCHD_PLIST}`);
        if (pidMatch) {
          console.log(`   PID: ${pidMatch[1]}`);
        }
      } catch {
        console.log('⚠️  macOS launchd scheduler: INSTALLED but not loaded');
        console.log(`   Plist: ${LAUNCHD_PLIST}`);
      }
    } catch {
      console.log('❌ macOS launchd scheduler: NOT INSTALLED');
    }
  } else if (platform === 'linux') {
    try {
      const existing = runCommandFile('crontab', ['-l']);
      if (existing.includes(CRONTAB_MARKER)) {
        console.log('✅ Linux crontab scheduler: INSTALLED');
      } else {
        console.log('❌ Linux crontab scheduler: NOT INSTALLED');
      }
    } catch {
      console.log('❌ Linux crontab scheduler: NOT INSTALLED');
    }
  }

  // Show queue status
  const scheduler = await createSchedulerService();
  const pending = await scheduler.list({ status: 'pending' });
  const overdue = pending.filter((e) => new Date(e.sendAt).getTime() < Date.now());

  console.log(`\n📬 Queue: ${pending.length} pending, ${overdue.length} overdue`);
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

const SCHEDULER_HELP = `
mailoo scheduler — Email scheduling management

Commands:
  check      Send overdue scheduled emails
  list       Display all scheduled emails
  install    Install OS periodic check (macOS launchd / Linux crontab)
  uninstall  Remove OS periodic check
  status     Show scheduler installation status
`.trim();

export default async function runSchedulerCommand(subcommand?: string): Promise<void> {
  switch (subcommand) {
    case 'check':
      await runCheck();
      break;
    case 'list':
      await runList();
      break;
    case 'install':
      await runInstall();
      break;
    case 'uninstall':
      await runUninstall();
      break;
    case 'status':
      await runStatus();
      break;
    case 'help':
    case '--help':
    case undefined:
      console.log(SCHEDULER_HELP);
      break;
    default:
      console.error(`Unknown scheduler command: ${subcommand}\n`);
      console.log(SCHEDULER_HELP);
  }
}
