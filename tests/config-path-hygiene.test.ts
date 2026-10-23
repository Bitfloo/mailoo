/**
 * A test that hands the config loader a path inside the repository reads whatever
 * file sits there, and its values can reach an assertion diff. Every test that
 * loads a config must point at a path in its own temp directory.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const repo = join(dirname(here), '..');
const REPO_PATH = /\b(?:repoRoot|__dirname|__filename)\b|import\.meta|process\.cwd/;
const CALL = /\bloadConfig\(([^)]*)\)/g;
const HAS_CALL = /\bloadConfig\(/;

/**
 * Arguments that are empty, literal (a relative path is the repo root under Vitest) or built
 * from the repo, and any line that builds a .toml path from it. A name such as `root` counts
 * only in a file that declares it from the repo: elsewhere it is often a temp directory.
 */
const offences = (source: string): string[] => {
  const names = [...source.matchAll(/^\s*(?:const|let)\s+(\w+)\s*=\s*(.*)$/gm)]
    .filter((declared) => REPO_PATH.test(declared[2]))
    .map((declared) => declared[1]);
  const fromRepo = new RegExp(`${REPO_PATH.source}|\\b(?:${['(?!)', ...names].join('|')})\\b`);
  const calls = [...source.matchAll(CALL)]
    .map((match) => match[1].trim())
    .filter((arg) => arg === '' || /^['"`]/.test(arg) || fromRepo.test(arg))
    .map((arg) => `argument '${arg}'`);
  const lines = source
    .split('\n')
    .filter((line) => fromRepo.test(line) && /\.toml\b/.test(line))
    .map((line) => `line '${line.trim()}'`);
  return [...calls, ...lines];
};

// This file is left out: its sample sources are the offences it looks for.
const callers = async (): Promise<string[]> => {
  const listed = await Promise.all(
    ['src', 'tests'].map(async (dir) =>
      (await readdir(join(repo, dir), { recursive: true })).map((file) => join(dir, file)),
    ),
  );
  const tests = listed
    .flat()
    .filter((file) => file.endsWith('.test.ts') && join(repo, file) !== here);
  const loads = await Promise.all(
    tests.map(async (file) => HAS_CALL.test(await readFile(join(repo, file), 'utf8'))),
  );
  return tests.filter((_file, index) => loads[index]).sort();
};

describe('tests that call the config loader', () => {
  it('should see the suites that load a config', async () => {
    const found = await callers();
    expect(found).toContain(join('tests', 'credential-facts.test.ts'));
    expect(found).toContain(join('src', 'identity.test.ts'));
  });

  it('should hand the loader no path from the repo root or the working directory', async () => {
    const found = await callers();
    const bad = await Promise.all(
      found.map(
        async (file) => [file, offences(await readFile(join(repo, file), 'utf8'))] as const,
      ),
    );
    expect(Object.fromEntries(bad.filter(([, list]) => list.length > 0))).toEqual({});
  });

  it.each([
    ["await loadConfig(join(repoRoot, 'no-such-config.toml'))", true],
    [
      "const root = join(import.meta.dirname, '..');\nconst missing = join(root, 'no-such-config.toml');\nawait loadConfig(missing)",
      true,
    ],
    ["await loadConfig(join(process.cwd(), 'config.toml'))", true],
    ["await loadConfig('no-such-config.toml')", true],
    ['await loadConfig()', true],
    [
      "const root = await mkdtemp(join(tmpdir(), 'x-'));\nawait loadConfig(join(root, 'config.toml'))",
      false,
    ],
    ["await loadConfig(join(dir, 'config.toml'))", false],
    ["await loadConfig(path.join(sandbox.dir, 'nonexistent.toml'))", false],
    ['await loadConfig(await writeConfig())', false],
  ] as const)('should flag %j: %s', (source, flagged) => {
    expect(offences(source).length > 0).toBe(flagged);
  });
});
