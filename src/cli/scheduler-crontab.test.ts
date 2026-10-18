import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { recordRunner, shQuote } from '../test-support/scheduler-cli.js';
import { installCrontabLine, removeCrontabLine } from './scheduler-install.js';

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
