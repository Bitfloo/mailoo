/**
 * The scheduler CLI loaded with HOME and PATH pointed at a throwaway directory. scheduler.ts
 * fixes its LaunchAgents path from os.homedir() when it loads, so a test that dropped its plist
 * path would otherwise write the user's LaunchAgents, and one that dropped its command runner
 * would run the user's launchctl or crontab. Test files take the CLI from this module.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-cli-home-'));
const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
// No directory on PATH holds launchctl or crontab, so a dropped runner fails with ENOENT.
vi.stubEnv('PATH', path.join(home, 'no-commands'));

export const {
  default: runSchedulerCommand,
  checkScheduledEmails,
  formatCheckResult,
  formatScheduledList,
  runCheck,
  runInstall,
  runList,
  runStatus,
  runUninstall,
  SCHEDULER_COMMANDS,
} = await import('../cli/scheduler.js');

afterAll(async () => {
  homeSpy.mockRestore();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});
