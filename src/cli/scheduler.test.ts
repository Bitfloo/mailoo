import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { CommandRunner } from './scheduler.js';
import { installCrontabLine, loadLaunchAgent, removeCrontabLine } from './scheduler.js';

const SRC = path.resolve('src');

const CHILD_PROCESS_NAMES = new Set(['execFile', 'execFileSync', 'spawn', 'spawnSync']);

// A call-site lookbehind misses `cp.execSync` and `childProcess.exec`.
// Imports may only name the four functions above. A namespace or default import
// is the module object, so it can still call exec.
const CHILD_PROCESS_IMPORT =
  /(?:^|\n)[ \t]*import\s+(?:type\s+)?([^;]*?)\s+from\s+['"](?:node:)?child_process['"]/g;
// A line-start anchor misses `const { execSync } = await import('node:child_process')`.
const CHILD_PROCESS_MODULE = /(?:import|require)\s*\(\s*['"](?:node:)?child_process['"]/;
const SHELL_LITERAL = /['"](?:[^'"]*\/)?(sh|bash|zsh|dash|cmd|pwsh|powershell)(?:\.exe)?['"]/g;

// desktopNotificationCommands runs one fixed PowerShell script built from string
// literals. Title and body are environment values, not the -Command text.
const CONSTANT_POWERSHELL_NOTIFIER = `${path.sep}services${path.sep}notifier.service.ts`;

function namedImportHits(clause: string): string[] {
  const brace = /\{([^}]*)\}/.exec(clause);
  if (!brace) return [];
  return brace[1]
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter((part) => part.length > 0)
    .map((part) => part.split(/\s+as\s+/)[0]?.trim() ?? '')
    .filter((name) => name.length > 0 && !CHILD_PROCESS_NAMES.has(name));
}

function childProcessImportHits(text: string): string[] {
  const fromImports = [...text.matchAll(new RegExp(CHILD_PROCESS_IMPORT.source, 'g'))].flatMap(
    (match) => {
      const clause = match[1]?.trim() ?? '';
      if (clause.startsWith('*') || clause.includes('* as ')) return ['namespace import'];
      const braceAt = clause.indexOf('{');
      const beforeBrace = (braceAt >= 0 ? clause.slice(0, braceAt) : clause)
        .replace(/,/g, '')
        .trim();
      return [...(beforeBrace.length > 0 ? ['default import'] : []), ...namedImportHits(clause)];
    },
  );
  const moduleImport = CHILD_PROCESS_MODULE.test(text) ? ['module import'] : [];
  return [...fromImports, ...moduleImport];
}

// A leading quote is not the whole argument: `'crontab -l | ' + line` still appends a variable.
function isWholeStringLiteral(arg: string): boolean {
  const text = arg.trim();
  const quote = text[0];
  if ((quote !== "'" && quote !== '"') || text.length < 2) return false;
  let i = 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
    } else if (text[i] === quote) {
      return i === text.length - 1;
    } else {
      i += 1;
    }
  }
  return false;
}

function variableShellHits(file: string, text: string): string[] {
  return [...text.matchAll(SHELL_LITERAL)].flatMap((match) => {
    const at = match.index ?? 0;
    const flag = /['"](-c|\/c|-Command)['"]\s*,\s*([^,\]\n)]+)/.exec(text.slice(at, at + 400));
    const arg = flag?.[2]?.trim() ?? '';
    if (!flag || isWholeStringLiteral(arg)) return [];
    const reason = `${match[1]} ${flag[1]} ${arg}`;
    // The Windows notifier is the one constant script. Other shells in that file still fail.
    if (file.endsWith(CONSTANT_POWERSHELL_NOTIFIER) && reason.startsWith('powershell -Command')) {
      return [];
    }
    return [reason];
  });
}

function shellHits(file: string, text: string): string[] {
  const hits = [
    ...childProcessImportHits(text),
    ...(/\bshell\s*:/.test(text) ? ['shell property'] : []),
    ...variableShellHits(file, text),
  ];
  return hits.map((hit) => `${path.relative(SRC, file)} ${hit}`);
}

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

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

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
  it('should not import a shell executor or build a shell command from a variable', async () => {
    const files = await productionSources(SRC);
    const texts = await Promise.all(
      files.map(async (file) => ({ file, text: await fs.readFile(file, 'utf8') })),
    );
    const hits = texts.flatMap(({ file, text }) => shellHits(file, text));
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
