/** A recording command runner, a line sink and shell quoting for the scheduler CLI tests. */

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

export function lineSink(): { lines: string[]; print: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    print: (line) => {
      lines.push(line);
    },
  };
}

export function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
