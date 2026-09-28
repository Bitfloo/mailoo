import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

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

  // execFileSync puts child stderr on the error only when that stream is piped.
  // The message stays "Command failed: ..." and does not include the crontab text.
  function crontabListError(stderrText: string): Error {
    const err = new Error('Command failed: crontab -l');
    return Object.assign(err, { status: 1, stderr: stderrText });
  }

  function mockCrontab(onList: () => string): { written: () => string | undefined } {
    let written: string | undefined;
    // eslint-disable-next-line n/no-sync -- mocked OS boundary; this does not spawn
    vi.mocked(execFileSync).mockImplementation((file, args, options) => {
      const input =
        typeof options === 'object' && options !== null && 'input' in options
          ? options.input
          : undefined;
      if (file === 'crontab' && args?.[0] === '-l') return onList();
      if (file === 'crontab' && args?.[0] === '-') written = typeof input === 'string' ? input : '';
      return '';
    });
    return { written: () => written };
  }

  it('should install one crontab line when the user has no crontab', () => {
    const line =
      "* * * * * '/usr/bin/node' '/opt/mailoo/main.js' scheduler check # mailoo scheduler";
    const { written } = mockCrontab(() => {
      throw crontabListError('crontab: no crontab for user\n');
    });
    expect(installCrontabLine(line, '# mailoo scheduler')).toBe(true);
    expect(written()).toBe(`${line}\n`);
    // eslint-disable-next-line n/no-sync -- mocked OS boundary; this does not spawn
    const { calls } = vi.mocked(execFileSync).mock;
    expect(calls[0]?.[2]).toMatchObject({ stdio: ['ignore', 'pipe', 'pipe'] });
    expect(calls[1]?.[2]).toMatchObject({ stdio: ['pipe', 'pipe', 'pipe'] });
  });

  it('should abort crontab install when listing fails for another reason', () => {
    const { written } = mockCrontab(() => {
      throw crontabListError('crontab: permission denied\n');
    });
    expect(() =>
      installCrontabLine('* * * * * /usr/bin/true # mailoo scheduler', '# mailoo scheduler'),
    ).toThrow(/permission denied/);
    expect(written()).toBeUndefined();
  });

  it('should keep blank lines when removing a crontab entry', () => {
    const existing = [
      '0 0 * * * /usr/bin/true',
      '',
      '* * * * * /opt/mailoo check # mailoo scheduler',
      '',
      '30 1 * * * /usr/bin/true',
      '',
    ].join('\n');
    const { written } = mockCrontab(() => existing);
    expect(removeCrontabLine('# mailoo scheduler')).toBe(true);
    expect(written()).toBe('0 0 * * * /usr/bin/true\n\n\n30 1 * * * /usr/bin/true\n');
  });
});
