import fs from 'node:fs/promises';
import path from 'node:path';

import {
  runCheck,
  runInstall,
  runList,
  runSchedulerCommand,
  runStatus,
  runUninstall,
  SCHEDULER_COMMANDS,
} from '../test-support/scheduler-home.js';
import type { SchedulerCommands } from './scheduler.js';
import { LAUNCHD_LABEL, runCommandFile } from './scheduler-install.js';

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

describe('shell commands in production code', () => {
  it('should not import a shell executor or build a shell command from a variable', async () => {
    const files = await productionSources(SRC);
    const texts = await Promise.all(
      files.map(async (file) => ({ file, text: await fs.readFile(file, 'utf8') })),
    );
    const hits = texts.flatMap(({ file, text }) => shellHits(file, text));
    expect(hits).toEqual([]);
  });
});

const SCHEDULER_CLI = path.join(SRC, 'cli', 'scheduler.js');
const VALUE_IMPORT = /(?:^|\n)[ \t]*(?:import|export)\s+(?!type\s)[^;]*?\bfrom\s+['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

async function testSources(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter(
      (file) => file.endsWith('.test.ts') || file.includes(`${path.sep}test-support${path.sep}`),
    );
}

describe('scheduler CLI imports in tests', () => {
  it('should load the scheduler CLI in tests only through the module that pins HOME and PATH', async () => {
    const files = await testSources(SRC);
    const importers = await Promise.all(
      files.map(async (file) => {
        const text = await fs.readFile(file, 'utf8');
        const specifiers = [...text.matchAll(VALUE_IMPORT), ...text.matchAll(DYNAMIC_IMPORT)];
        const loadsCli = specifiers.some(
          ([, specifier = '']) => path.resolve(path.dirname(file), specifier) === SCHEDULER_CLI,
        );
        return loadsCli ? [path.relative(SRC, file)] : [];
      }),
    );
    expect(importers.flat()).toEqual([path.join('test-support', 'scheduler-home.ts')]);
  });

  it('should leave launchctl and crontab off PATH, so a test that drops its runner cannot run them', () => {
    const codes = [
      ['launchctl', 'list', LAUNCHD_LABEL],
      ['crontab', '-l'],
    ].map(([file = '', ...args]) => {
      try {
        runCommandFile(file, args);
        return 'ran';
      } catch (err) {
        return (err as { code?: unknown }).code;
      }
    });
    expect(codes).toEqual(['ENOENT', 'ENOENT']);
  });
});

function recordedCommands(): { commands: SchedulerCommands; ran: string[] } {
  const ran: string[] = [];
  const record = (name: string) => async () => {
    ran.push(name);
  };
  const commands = {
    check: record('check'),
    list: record('list'),
    install: record('install'),
    uninstall: record('uninstall'),
    status: record('status'),
  };
  return { commands, ran };
}

/** Runs the router with console output captured; the help names a command at two-space indent. */
async function route(subcommand: string | undefined): Promise<{
  ran: string[];
  helpNames: string[];
  stderr: unknown[];
}> {
  const { commands, ran } = recordedCommands();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await runSchedulerCommand(subcommand, commands);
    const printed = log.mock.calls.flat().join('\n');
    const helpNames = [...printed.matchAll(/^ {2}(\S+)/gm)].map((match) => match[1] ?? '');
    return { ran, helpNames, stderr: error.mock.calls.flat() };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe('scheduler subcommand router', () => {
  it('should run each subcommand through its exported run function by default', () => {
    expect(SCHEDULER_COMMANDS).toEqual({
      check: runCheck,
      list: runList,
      install: runInstall,
      uninstall: runUninstall,
      status: runStatus,
    });
  });

  it('should run the exported list command when no command map is given', async () => {
    const ran: string[] = [];
    const list = vi.spyOn(SCHEDULER_COMMANDS, 'list').mockImplementation(async () => {
      ran.push('list');
    });
    try {
      await runSchedulerCommand('list');
      expect(ran).toEqual(['list']);
    } finally {
      list.mockRestore();
    }
  });

  it('should run the command each subcommand names', async () => {
    const { commands, ran } = recordedCommands();
    const names = Object.keys(commands);
    await Promise.all(names.map(async (name) => runSchedulerCommand(name, commands)));
    expect(ran).toEqual(names);
  });

  it.each([undefined, 'help', '--help'])(
    'should print the help naming every subcommand and run nothing for %s',
    async (subcommand) => {
      expect(await route(subcommand)).toEqual({
        ran: [],
        helpNames: Object.keys(recordedCommands().commands),
        stderr: [],
      });
    },
  );

  it('should name an unknown subcommand on stderr, print the help and run nothing', async () => {
    expect(await route('bogus')).toEqual({
      ran: [],
      helpNames: Object.keys(recordedCommands().commands),
      stderr: ['Unknown scheduler command: bogus\n'],
    });
  });
});
