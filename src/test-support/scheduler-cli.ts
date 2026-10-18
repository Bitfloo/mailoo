/** Command runners, a line sink, a temp plist path and shell quoting for the scheduler CLI tests. */

import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CommandRunner } from '../cli/scheduler-install.js';

export function recordRunner(crontab = '0 0 * * * /usr/bin/true\n'): {
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

/** What `launchctl list <label>` prints for a loaded agent. Only a running one has a PID line. */
export function launchctlListing(label: string, pid?: number): string {
  return [
    '{',
    '\t"StandardOutPath" = "/tmp/mailoo-scheduler.log";',
    '\t"LimitLoadToSessionType" = "Aqua";',
    '\t"StandardErrorPath" = "/tmp/mailoo-scheduler.log";',
    `\t"Label" = "${label}";`,
    '\t"OnDemand" = true;',
    '\t"LastExitStatus" = 0;',
    ...(pid === undefined ? [] : [`\t"PID" = ${pid};`]),
    '\t"Program" = "/usr/local/bin/node";',
    '\t"ProgramArguments" = (',
    '\t\t"/usr/local/bin/node";',
    '\t\t"/opt/mailoo/main.js";',
    '\t\t"scheduler";',
    '\t\t"check";',
    '\t);',
    '};',
    '',
  ].join('\n');
}

/**
 * launchctl as launchctl(1) documents it: `load` and `unload` exit 0 even when they fail, so
 * only `list <label>` shows whether the agent is loaded, exiting 113 when it is not. Like
 * launchctl, `load` and `unload` read the plist when they run; each read is recorded.
 */
export function fakeLaunchctl(options: { loaded?: string; loadFails?: boolean } = {}): {
  run: CommandRunner;
  agent: { loaded: string | undefined };
  reads: { subcommand: string; plist: string | undefined }[];
} {
  const agent = { loaded: options.loaded };
  const reads: { subcommand: string; plist: string | undefined }[] = [];
  const run: CommandRunner = (file, [subcommand = '', target = '']) => {
    if (file !== 'launchctl') throw new Error(`fakeLaunchctl cannot run ${file}`);
    if (subcommand === 'list') {
      if (agent.loaded !== undefined) return launchctlListing(target);
      const stderr = `Could not find service "${target}" in domain for port\n`;
      throw Object.assign(new Error(`Command failed: launchctl list ${target}\n${stderr}`), {
        status: 113,
        stderr,
      });
    }
    // eslint-disable-next-line n/no-sync -- a CommandRunner is synchronous, as execFileSync is
    const plist = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
    reads.push({ subcommand, plist });
    // A missing plist, an agent already loaded or a refused load leaves launchd as it was.
    if (subcommand === 'unload' && plist !== undefined) agent.loaded = undefined;
    const loads = plist !== undefined && agent.loaded === undefined && options.loadFails !== true;
    if (subcommand === 'load' && loads) agent.loaded = plist;
    return '';
  };
  return { run, agent, reads };
}

export function lineSink(): { lines: string[]; print: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    print: (line) => {
      lines.push(line);
    },
  };
}

/** A plist path in a LaunchAgents directory that does not exist yet, removed afterwards. */
export async function withPlistPath(body: (plistPath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-launchd-'));
  try {
    await body(path.join(dir, 'LaunchAgents', 'agent.plist'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
