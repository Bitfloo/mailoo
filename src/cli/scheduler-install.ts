/**
 * What `mailoo scheduler install` hands the OS: the launchd plist and the crontab line,
 * and the launchctl and crontab calls that hand them over.
 */

/* eslint-disable n/no-sync -- CLI install waits for launchctl and crontab */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { SCHEDULER_INTERVAL_MS } from '../services/scheduler.service.js';

export const LAUNCHD_LABEL = 'com.bitfloo.mailoo.scheduler';
export const CRONTAB_MARKER = '# mailoo scheduler';
// The OS daemon runs the check as often as the server does.
export const CHECK_INTERVAL_SECONDS = SCHEDULER_INTERVAL_MS / 1000;

function quoteCronArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildLaunchdPlist(nodePath: string, cliPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>scheduler</string>
    <string>check</string>
  </array>
  <key>StartInterval</key>
  <integer>${CHECK_INTERVAL_SECONDS}</integer>
  <key>StandardOutPath</key>
  <string>/tmp/mailoo-scheduler.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/mailoo-scheduler.log</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
}

/** Cron counts whole minutes, so the minute field steps by the interval in minutes. */
export function buildCronLine(nodePath: string, cliPath: string): string {
  return `*/${CHECK_INTERVAL_SECONDS / 60} * * * * ${quoteCronArg(nodePath)} ${quoteCronArg(cliPath)} scheduler check ${CRONTAB_MARKER}`;
}

export type CommandRunner = (file: string, args: readonly string[], input?: string) => string;

export function runCommandFile(file: string, args: readonly string[], input?: string): string {
  // crontab reports a missing table on stderr. Discarding it leaves stderr null
  // and the Error message omits the text, so a permission failure looks empty.
  const stderr = file === 'crontab' ? 'pipe' : 'ignore';
  return execFileSync(file, [...args], {
    encoding: 'utf-8',
    stdio: input === undefined ? ['ignore', 'pipe', stderr] : ['pipe', 'pipe', stderr],
    ...(input === undefined ? {} : { input }),
  });
}

function stderrText(err: unknown): string {
  if (typeof err !== 'object' || err === null || !('stderr' in err)) return '';
  const { stderr } = err as { stderr?: unknown };
  return typeof stderr === 'string' ? stderr : '';
}

// Exit status 1 is also used when crontab cannot be read. Only this stderr text
// means the user has no crontab.
function isNoCrontab(err: unknown): boolean {
  return /no crontab for/i.test(stderrText(err));
}

function crontabReadError(err: unknown): Error {
  const detail = stderrText(err).trim();
  const fallback = err instanceof Error ? err.message : String(err);
  return new Error(`Could not read the crontab: ${detail.length > 0 ? detail : fallback}`);
}

function readCrontab(run: CommandRunner): string | undefined {
  try {
    return run('crontab', ['-l']);
  } catch (err) {
    if (isNoCrontab(err)) return undefined;
    throw crontabReadError(err);
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
  const existing = readCrontab(run) ?? '';
  if (existing.includes(marker)) return false;
  const body = existing.trim().length === 0 ? `${line}\n` : `${existing.trimEnd()}\n${line}\n`;
  run('crontab', ['-'], body);
  return true;
}

export function removeCrontabLine(marker: string, run: CommandRunner = runCommandFile): boolean {
  const lines = (readCrontab(run) ?? '').split('\n');
  const kept = lines.filter((entry) => !entry.includes(marker));
  if (kept.length === lines.length) return false;
  const body = kept.join('\n');
  run('crontab', ['-'], body.endsWith('\n') ? body : `${body}\n`);
  return true;
}
