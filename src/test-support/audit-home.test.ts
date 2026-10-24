import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { pinAuditHome, readAuditEntries } from './audit-home.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const AUDIT_MODULE = path.join(root, 'src', 'safety', 'audit.ts');

/**
 * Suites that load audit.ts but only list tools, run the MCP handshake, or call handlers
 * that write no audit entry. Each must still load it unpinned: pin one, then drop it here.
 */
const LOADS_AUDIT_WITHOUT_WRITING = new Set([
  'src/__integration__/http-host.integration.test.ts',
  'src/__integration__/http-session-eviction.integration.test.ts',
  'src/__integration__/http-session-ids.integration.test.ts',
  'src/__integration__/http-session-logging.integration.test.ts',
  'src/__integration__/http-session.integration.test.ts',
  'src/mcp-catalog.test.ts',
  'src/safety/http-session-scope.test.ts',
  'src/services/tools-doc.test.ts',
  'src/tools/annotations.test.ts',
  'src/tools/register.test.ts',
  'src/tools/scheduler.tool.test.ts',
]);

const PIN_CALL = /\bpinAuditHome\s*\(/;

const RESTORE_HOOKS = new Set(['afterAll', 'afterEach']);

interface AuditHomeUse {
  pins: number;
  restores: number;
  balanced: boolean;
}

/**
 * pinAuditHome() calls against restore() calls made inside afterAll or afterEach. Counts call
 * nodes, not text, so a commented-out restore or a call quoted in a string is not seen.
 */
function auditHomeUse(source: string): AuditHomeUse {
  const file = ts.createSourceFile('suite.test.ts', source, ts.ScriptTarget.Latest);
  const counts = { pins: 0, restores: 0 };
  const visit = (node: ts.Node, inHook: boolean): void => {
    let hooked = inHook;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === 'pinAuditHome') counts.pins += 1;
      if (ts.isIdentifier(callee) && RESTORE_HOOKS.has(callee.text)) hooked = true;
      if (
        inHook &&
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'restore' &&
        node.arguments.length === 0
      ) {
        counts.restores += 1;
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child, hooked);
    });
  };
  visit(file, false);
  return { ...counts, balanced: counts.pins === counts.restores };
}

/** The helper's own tests restore each home inline, in finally: restore is what they test. */
const THIS_FILE = path
  .relative(root, fileURLToPath(import.meta.url))
  .split(path.sep)
  .join('/');

/** Ways a suite keeps audit.log out of the user's data directory. */
const AUDIT_PINS = [
  PIN_CALL,
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

  it('should put a previously set XDG_DATA_HOME back on restore', async () => {
    // CI leaves XDG_DATA_HOME unset, so the restore-the-old-value branch needs its own value.
    vi.stubEnv('XDG_DATA_HOME', '/previous/data');
    try {
      const home = await pinAuditHome();
      await home.restore();
      expect(process.env.XDG_DATA_HOME).toBe('/previous/data');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('readAuditEntries', () => {
  it('should return no entries before the first audit write', async () => {
    const home = await pinAuditHome();
    try {
      await expect(readAuditEntries(home)).resolves.toEqual([]);
    } finally {
      await home.restore();
    }
  });

  it('should rethrow a read error that is not ENOENT', async () => {
    const home = await pinAuditHome();
    try {
      await mkdir(path.join(home.dir, 'mailoo', 'audit.log'), { recursive: true });
      await expect(readAuditEntries(home)).rejects.toMatchObject({ code: 'EISDIR' });
    } finally {
      await home.restore();
    }
  });
});

const PIN_IN_HOISTED = `const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome() };
});
`;

const PIN_IN_BEFORE_EACH = `let auditHome: AuditHome;

beforeEach(async () => {
  auditHome = await pinAuditHome();
});
`;

const BALANCED = { pins: 1, restores: 1, balanced: true };
const PINNED_NOT_RESTORED = { pins: 1, restores: 0, balanced: false };

describe('auditHomeUse', () => {
  it.each([
    [
      'accept a restore in an async afterAll',
      `${PIN_IN_HOISTED}
afterAll(async () => {
  await auditHome.restore();
});
`,
      BALANCED,
    ],
    [
      'accept a restore in an async afterEach after other cleanup',
      `${PIN_IN_BEFORE_EACH}
afterEach(async () => {
  vi.unstubAllGlobals();
  await auditHome.restore();
});
`,
      BALANCED,
    ],
    [
      'accept a restore returned from a synchronous afterAll',
      `${PIN_IN_HOISTED}
afterAll(() => {
  return auditHome.restore();
});
`,
      BALANCED,
    ],
    [
      'accept a restore as the expression body of an afterEach',
      `${PIN_IN_BEFORE_EACH}
afterEach(() => auditHome.restore());
`,
      BALANCED,
    ],
    [
      'reject a restore() commented out with //',
      `${PIN_IN_HOISTED}
afterAll(async () => {
  // await auditHome.restore();
});
`,
      PINNED_NOT_RESTORED,
    ],
    [
      'reject a restore() inside a block comment',
      `${PIN_IN_HOISTED}
afterAll(async () => {
  /* await auditHome.restore(); */
});
`,
      PINNED_NOT_RESTORED,
    ],
    [
      'reject two pins that share one restore',
      `const { auditHome } = await vi.hoisted(async () => {
  const { pinAuditHome } = await import('../test-support/audit-home.js');
  return { auditHome: await pinAuditHome(), spare: await pinAuditHome() };
});

afterAll(async () => {
  await auditHome.restore();
});
`,
      { pins: 2, restores: 1, balanced: false },
    ],
    [
      'reject a restore() made outside an afterAll or afterEach',
      `${PIN_IN_HOISTED}
it('should leave the home to the end of the run', async () => {
  await auditHome.restore();
});
`,
      PINNED_NOT_RESTORED,
    ],
    [
      'reject an afterEach that only restores mocks',
      `${PIN_IN_BEFORE_EACH}
afterEach(() => {
  vi.restoreAllMocks();
});
`,
      PINNED_NOT_RESTORED,
    ],
    [
      'ignore a pin and a restore quoted in string literals',
      `const note = 'pinAuditHome() then auditHome.restore()';
afterAll(() => {
  expect(\`pinAuditHome()\`).toBe(note);
});
`,
      { pins: 0, restores: 0, balanced: true },
    ],
  ])('should %s', (_title, source, use) => {
    expect(auditHomeUse(source)).toEqual(use);
  });
});

describe('audit home roster', () => {
  let loading: { file: string; pinned: boolean }[] = [];
  let pinning: ({ file: string } & AuditHomeUse)[] = [];

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
    pinning = files
      .map((file, i) => ({ file, ...auditHomeUse(texts[i] ?? '') }))
      .filter(({ file, pins }) => file !== THIS_FILE && pins > 0);
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

  it('should restore in an afterAll or afterEach every audit home a test file pins', () => {
    expect({
      pinned: pinning.map((entry) => entry.file),
      unrestored: pinning.filter((entry) => !entry.balanced),
    }).toEqual({
      // One afterAll and one afterEach suite, so a pin regex that matches nothing cannot pass.
      pinned: expect.arrayContaining([
        'src/tools/manage.tool.oauth-error.test.ts',
        'src/tools/tool-errors.test.ts',
      ]),
      unrestored: [],
    });
  });
});
