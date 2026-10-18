/**
 * What `mailoo scheduler install` hands the OS: the launchd plist and the crontab line.
 */

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
