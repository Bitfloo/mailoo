/**
 * CLI scheduler subcommands.
 *
 * Provides check, list, install, uninstall, and status subcommands
 * for managing the email scheduler.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../config/loader.js';
import { createMailServices } from '../services/mail-services.js';
import SchedulerService, { isSendTimeReached } from '../services/scheduler.service.js';
import type { AppConfig, ScheduledEmail } from '../types/index.js';
import type { CommandRunner } from './scheduler-install.js';
import {
  buildCronLine,
  buildLaunchdPlist,
  CHECK_INTERVAL_SECONDS,
  CRONTAB_MARKER,
  installCrontabLine,
  LAUNCHD_LABEL,
  loadLaunchAgent,
  removeCrontabLine,
  runCommandFile,
} from './scheduler-install.js';

const LAUNCHD_PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LAUNCHD_PLIST = path.join(LAUNCHD_PLIST_DIR, `${LAUNCHD_LABEL}.plist`);

function getExecutablePath(): string {
  return process.argv[1] ?? 'mailoo';
}

// A pooled SMTP socket or an IMAP session left open keeps a cron run alive
// after its work is done.
async function withScheduler<T>(
  config: AppConfig,
  run: (scheduler: SchedulerService) => Promise<T>,
  queueDir?: string,
): Promise<T> {
  const { connections, imap, smtp } = createMailServices(config);
  try {
    return await run(new SchedulerService(smtp, imap, queueDir));
  } finally {
    await connections.closeAll();
  }
}

type CheckResult = Awaited<ReturnType<SchedulerService['checkAndSend']>>;

export async function checkScheduledEmails(
  config: AppConfig,
  queueDir?: string,
): Promise<CheckResult> {
  return withScheduler(config, async (scheduler) => scheduler.checkAndSend(), queueDir);
}

/** What `mailoo scheduler check` prints for one check. */
export function formatCheckResult(result: CheckResult): string[] {
  const lines: string[] = [];
  if (result.sent > 0) {
    lines.push(`✅ Sent ${result.sent} scheduled email(s)`);
  }
  if (result.failed > 0) {
    lines.push(`❌ Failed: ${result.failed}`);
  }
  if (result.deferred > 0) {
    lines.push(`⏳ Held back by the rate limit: ${result.deferred} (retried on the next check)`);
  }
  // A delivered email can carry an error too, when its queue record was not updated.
  lines.push(...result.errors.map((err) => `   ${err}`));
  if (result.sent === 0 && result.failed === 0 && result.deferred === 0) {
    lines.push('No overdue scheduled emails.');
  }
  return lines;
}

async function listScheduled(
  status: 'all' | 'pending',
  load: () => Promise<AppConfig> = loadConfig,
  queueDir?: string,
): Promise<ScheduledEmail[]> {
  const list = async (scheduler: SchedulerService) => scheduler.list({ status });
  return withScheduler(await load(), list, queueDir);
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/** `mailoo scheduler check`. A test passes a temp config, a line sink and a temp queue. */
export async function runCheck(
  load: () => Promise<AppConfig> = loadConfig,
  print: (line: string) => void = console.log,
  queueDir?: string,
): Promise<void> {
  const result = await checkScheduledEmails(await load(), queueDir);
  formatCheckResult(result).forEach((line) => {
    print(line);
  });
}

/** What `mailoo scheduler list` prints for the queue. */
export function formatScheduledList(emails: ScheduledEmail[]): string[] {
  if (emails.length === 0) {
    return ['No scheduled emails.'];
  }

  const lines: string[] = [];
  const pending = emails.filter((e) => e.status === 'pending');
  const sending = emails.filter((e) => e.status === 'sending');
  const sent = emails.filter((e) => e.status === 'sent');
  const failed = emails.filter((e) => e.status === 'failed');

  if (pending.length > 0) {
    lines.push(`\n📬 Pending (${pending.length}):`);
    pending.forEach((e) => {
      const overdue = isSendTimeReached(e.sendAt, Date.now()) ? ' ⚠️ OVERDUE' : '';
      lines.push(
        `  ${e.id.slice(0, 8)} | ${e.account} → ${e.to.join(', ')} | "${e.subject}" | ${e.sendAt}${overdue}`,
      );
    });
  }

  if (sending.length > 0) {
    lines.push(`\n📤 Sending (${sending.length}):`);
    sending.forEach((e) => {
      lines.push(
        `  ${e.id.slice(0, 8)} | ${e.account} → ${e.to.join(', ')} | "${e.subject}" | ${e.sendAt}`,
      );
    });
  }

  if (sent.length > 0) {
    lines.push(`\n✅ Sent (${sent.length}):`);
    sent.forEach((e) => {
      lines.push(
        `  ${e.id.slice(0, 8)} | ${e.account} → ${e.to.join(', ')} | "${e.subject}" | sent ${e.sentAt}`,
      );
    });
  }

  if (failed.length > 0) {
    lines.push(`\n❌ Failed (${failed.length}):`);
    failed.forEach((e) => {
      lines.push(
        `  ${e.id.slice(0, 8)} | ${e.account} → ${e.to.join(', ')} | "${e.subject}" | ${e.lastError}`,
      );
    });
  }
  return lines;
}

/** `mailoo scheduler list`. A test passes a temp config, a line sink and a temp queue. */
export async function runList(
  load: () => Promise<AppConfig> = loadConfig,
  print: (line: string) => void = console.log,
  queueDir?: string,
): Promise<void> {
  formatScheduledList(await listScheduled('all', load, queueDir)).forEach((line) => {
    print(line);
  });
}

/**
 * `mailoo scheduler install`. A test passes the platform, a command runner, a line sink
 * and a temp plist path.
 */
export async function runInstall(
  platform: NodeJS.Platform = os.platform(),
  run: CommandRunner = runCommandFile,
  print: (line: string) => void = console.log,
  plistPath: string = LAUNCHD_PLIST,
): Promise<void> {
  const execPath = getExecutablePath();

  if (platform === 'darwin') {
    // macOS: launchd plist
    await loadLaunchAgent(plistPath, buildLaunchdPlist(process.execPath, execPath), run);

    print('✅ Installed macOS launchd scheduler');
    print(`   Plist: ${plistPath}`);
    print(`   Runs every ${CHECK_INTERVAL_SECONDS} seconds`);
  } else if (platform === 'linux') {
    // Linux: crontab
    if (!installCrontabLine(buildCronLine(process.execPath, execPath), CRONTAB_MARKER, run)) {
      print('⚠️  Scheduler crontab entry already exists');
      return;
    }

    print('✅ Installed Linux crontab scheduler');
    print(`   Runs every ${CHECK_INTERVAL_SECONDS} seconds`);
  } else {
    console.error(`❌ Unsupported platform: ${platform}`);
    console.error("   Manually run 'mailoo scheduler check' on a schedule.");
  }
}

/**
 * `mailoo scheduler uninstall`. A test passes the platform, a command runner, a line sink
 * and a temp plist path.
 */
export async function runUninstall(
  platform: NodeJS.Platform = os.platform(),
  run: CommandRunner = runCommandFile,
  print: (line: string) => void = console.log,
  plistPath: string = LAUNCHD_PLIST,
): Promise<void> {
  if (platform === 'darwin') {
    try {
      run('launchctl', ['unload', plistPath]);
    } catch {
      // May not be loaded
    }

    try {
      await fs.unlink(plistPath);
      print('✅ Removed macOS launchd scheduler');
    } catch {
      print('ℹ️  No launchd scheduler found');
    }
  } else if (platform === 'linux') {
    if (removeCrontabLine(CRONTAB_MARKER, run)) {
      print('✅ Removed Linux crontab scheduler');
    } else {
      print('ℹ️  No crontab scheduler found');
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
  const pending = await listScheduled('pending');
  const overdue = pending.filter((e) => isSendTimeReached(e.sendAt, Date.now()));

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
