import { access, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pinAuditHome } from './audit-home.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const AUDIT_MODULE = path.join(root, 'src', 'safety', 'audit.ts');

/**
 * Suites that load audit.ts but only list tools, run the MCP handshake, or call handlers
 * that write no audit entry. Each must still load it unpinned: pin one, then drop it here.
 */
const LOADS_AUDIT_WITHOUT_WRITING = new Set([
  'src/__integration__/http-session.integration.test.ts',
  'src/mcp-catalog.test.ts',
  'src/safety/http-session-scope.test.ts',
  'src/tools/annotations.test.ts',
  'src/tools/register.test.ts',
  'src/tools/scheduler.tool.test.ts',
  'src/tools/tool-errors.test.ts',
]);

/** Ways a suite keeps audit.log out of the user's data directory. */
const AUDIT_PINS = [
  /\bpinAuditHome\s*\(/,
  /vi\.mock\(\s*['"][^'"]*(?:safety\/|\.\/)audit\.js['"]/,
  /vi\.stubEnv\(\s*['"]XDG_DATA_HOME['"]/,
  /vi\.mock\(\s*['"]node:fs\/promises['"]\s*\)/,
];

/** Relative specifiers a module loads at run time; `import type` is erased and skipped. */
const RUNTIME_IMPORTS = [
  /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\bfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/gm,
  /\bimport(?:Actual)?(?:<[^>]*>)?\(\s*['"](\.{1,2}\/[^'"]+)['"]/g,
];

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function resolveSpecifier(from: string, specifier: string): Promise<string | undefined> {
  const file = path.resolve(path.dirname(from), specifier).replace(/\.js$/, '.ts');
  return (await exists(file)) ? file : undefined;
}

const importsOf = new Map<string, Promise<string[]>>();

async function runtimeImports(file: string): Promise<string[]> {
  let pending = importsOf.get(file);
  if (!pending) {
    pending = readFile(file, 'utf8').then(async (text) => {
      const specifiers = RUNTIME_IMPORTS.flatMap((pattern) =>
        Array.from(text.matchAll(pattern), (match) => match[1] ?? ''),
      );
      const resolved = await Promise.all(specifiers.map(async (s) => resolveSpecifier(file, s)));
      return resolved.filter((p): p is string => p !== undefined);
    });
    importsOf.set(file, pending);
  }
  return pending;
}

async function loadsAudit(entry: string): Promise<boolean> {
  const seen = new Set<string>();
  let frontier = [entry];
  while (frontier.length > 0) {
    if (frontier.includes(AUDIT_MODULE)) return true;
    frontier.forEach((file) => {
      seen.add(file);
    });
    // eslint-disable-next-line no-await-in-loop -- breadth-first: each level needs the last.
    const next = (await Promise.all(frontier.map(runtimeImports))).flat();
    frontier = [...new Set(next)].filter((file) => !seen.has(file));
  }
  return false;
}

async function testFiles(): Promise<string[]> {
  const dirs = ['src', 'tests'];
  const listed = await Promise.all(
    dirs.map(async (dir) =>
      (await readdir(path.join(root, dir), { recursive: true }))
        .filter((name) => name.endsWith('.test.ts'))
        .map((name) => path.join(dir, name).split(path.sep).join('/')),
    ),
  );
  return listed.flat().sort();
}

describe('pinAuditHome', () => {
  it('should point XDG_DATA_HOME at a new directory under the OS temp directory', async () => {
    const home = await pinAuditHome();
    try {
      expect({
        env: process.env.XDG_DATA_HOME,
        underTmp: home.dir.startsWith(os.tmpdir()),
        exists: await exists(home.dir),
      }).toEqual({ env: home.dir, underTmp: true, exists: true });
    } finally {
      await home.restore();
    }
  });

  it('should put XDG_DATA_HOME back and remove the directory on restore', async () => {
    const before = process.env.XDG_DATA_HOME;
    const home = await pinAuditHome();
    await home.restore();
    expect({ env: process.env.XDG_DATA_HOME, exists: await exists(home.dir) }).toEqual({
      env: before,
      exists: false,
    });
  });

  it('should delete XDG_DATA_HOME on restore when it was unset', async () => {
    vi.stubEnv('XDG_DATA_HOME', undefined);
    try {
      const home = await pinAuditHome();
      await home.restore();
      expect('XDG_DATA_HOME' in process.env).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('audit home roster', () => {
  let loading: { file: string; pinned: boolean }[] = [];

  beforeAll(async () => {
    const files = await testFiles();
    const loads = await Promise.all(files.map(async (file) => loadsAudit(path.join(root, file))));
    const texts = await Promise.all(
      files.map(async (file) => readFile(path.join(root, file), 'utf8')),
    );
    loading = files
      .map((file, i) => ({
        file,
        loads: loads[i],
        pinned: AUDIT_PINS.some((pin) => pin.test(texts[i] ?? '')),
      }))
      .filter((entry) => entry.loads)
      .map(({ file, pinned }) => ({ file, pinned }));
  });

  it('should find the suites that read the audit log among those that load audit.ts', () => {
    expect(loading.map((entry) => entry.file)).toEqual(
      expect.arrayContaining(['src/tools/calendar.tool.test.ts', 'src/tools/watcher.tool.test.ts']),
    );
  });

  it('should pin the audit home in every test file that loads src/safety/audit.ts', () => {
    expect(
      loading
        .filter((entry) => !entry.pinned && !LOADS_AUDIT_WITHOUT_WRITING.has(entry.file))
        .map((entry) => entry.file),
    ).toEqual([]);
  });

  it('should list as audit-free only suites that still load audit.ts unpinned', () => {
    const unpinned = new Set(loading.filter((e) => !e.pinned).map((e) => e.file));
    expect([...LOADS_AUDIT_WITHOUT_WRITING].filter((file) => !unpinned.has(file))).toEqual([]);
  });
});
