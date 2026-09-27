import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CommandRunner } from './scheduler.js';
import { installCrontabLine, loadLaunchAgent, removeCrontabLine } from './scheduler.js';

const SRC = path.resolve('src');

const SHELL_CALL = [/(?<![.\w])execSync\s*\(/, /(?<![.\w])exec\s*\(/, /shell\s*:\s*true/];

async function productionSources(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(
      (file) =>
        file.endsWith('.ts') &&
        !file.endsWith('.test.ts') &&
        !file.includes(`${path.sep}__integration__${path.sep}`),
    );
}

function recordRunner(): {
  run: CommandRunner;
  calls: { file: string; args: string[]; input?: string }[];
} {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const run: CommandRunner = (file, args, input) => {
    calls.push({ file, args: [...args], input });
    if (file === 'crontab' && args[0] === '-l') return '0 0 * * * /usr/bin/true\n';
    return '';
  };
  return { run, calls };
}

describe('scheduler install commands', () => {
  it('should not run a shell command from production source', async () => {
    const files = await productionSources(SRC);
    const texts = await Promise.all(
      files.map(async (file) => ({ file, text: await fs.readFile(file, 'utf8') })),
    );
    const hits = texts.flatMap(({ file, text }) =>
      SHELL_CALL.filter((pattern) => pattern.test(text)).map(
        (pattern) => `${path.relative(SRC, file)} ${pattern.source}`,
      ),
    );
    expect(hits).toEqual([]);
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
});
