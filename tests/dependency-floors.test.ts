import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { parse } from 'yaml';

import { repoRoot } from './agents/agent-file.js';

/**
 * Floors are the lowest releases that keep `pnpm audit --prod` free of high
 * and critical findings for these packages, plus the test-runner floor.
 * Every resolved copy in the lockfile counts: one old copy is enough to fail.
 */
const FLOORS: Record<string, string> = {
  nodemailer: '10.0.0',
  'smol-toml': '1.9.0',
  '@modelcontextprotocol/sdk': '1.31.0',
  'proxy-addr': '2.0.8',
  hono: '4.12.25',
  '@hono/node-server': '1.19.10',
  'express-rate-limit': '8.2.2',
  'path-to-regexp': '8.4.0',
  'fast-uri': '3.1.9',
  'ip-address': '10.7.4',
  qs: '6.16.1',
  'body-parser': '2.4.0',
  glob: '14.0.2',
  // GHSA-5xrq-8626-4rwp: before 4.1.0 the Vitest UI server could read and execute files.
  vitest: '4.1.0',
};

function compareSemver(left: string, right: string): number {
  const a = left.split('.').map((part) => Number.parseInt(part, 10));
  const b = right.split('.').map((part) => Number.parseInt(part, 10));
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const da = a[i] ?? 0;
    const db = b[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function resolvedVersions(lockfile: string, name: string): string[] {
  const versions = new Set<string>();
  for (const line of lockfile.split('\n')) {
    if (!line.startsWith('  ') || line.startsWith('    ')) continue;
    let key = line.trim();
    if (!key.endsWith(':')) continue;
    key = key.slice(0, -1);
    if (key.startsWith("'") && key.endsWith("'")) key = key.slice(1, -1);
    const peer = key.indexOf('(');
    if (peer !== -1) key = key.slice(0, peer);
    const at = key.lastIndexOf('@');
    if (at <= 0) continue;
    if (key.slice(0, at) === name) versions.add(key.slice(at + 1));
  }
  return [...versions];
}

function optimizationLevels(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'optimizationLevel' ? [child] : optimizationLevels(child),
  );
}

describe('dependency security floors', () => {
  const lockfile = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8');

  it.each(Object.entries(FLOORS))('resolves %s at or above %s', (name, floor) => {
    const versions = resolvedVersions(lockfile, name);
    expect(versions.length).toBeGreaterThan(0);
    const below = versions.filter((version) => compareSemver(version, floor) < 0);
    expect(below).toEqual([]);
  });

  it('should keep unpatched minimatch copies within the reviewed compatibility exceptions', () => {
    // Versions 3/5 lack the affected preprocessing; version 10 is limited to the lint callers below.
    // Their callable CommonJS and makeRe APIs are absent in minimatch 11.
    const retained = new Set(['3.1.5', '5.1.9', '10.2.6']);
    const versions = resolvedVersions(lockfile, 'minimatch');
    expect(versions.length).toBeGreaterThan(0);
    expect(
      versions.filter((version) => !retained.has(version) && compareSemver(version, '11.0.1') < 0),
    ).toEqual([]);
  });

  it('should restrict minimatch 10 to the reviewed lint consumers', () => {
    const { snapshots } = parse(lockfile) as {
      snapshots: Record<
        string,
        { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
      >;
    };
    const consumers = Object.entries(snapshots)
      .filter(
        ([, entry]) =>
          (entry.dependencies?.minimatch ?? entry.optionalDependencies?.minimatch) === '10.2.6',
      )
      .map(([key]) => key.split('(')[0])
      .sort();
    expect(consumers).toEqual([
      '@typescript-eslint/typescript-estree@8.71.2',
      'eslint-plugin-import-x@4.17.1',
    ]);
  });

  it('should keep the lint configuration below minimatch optimization level 2', async () => {
    // import-x exposes patternOptions; the vulnerable preprocessing must not be enabled here.
    const config = await new ESLint().calculateConfigForFile('src/main.ts');
    expect(config).toBeDefined();
    expect(
      optimizationLevels(config.rules).filter((level) => typeof level !== 'number' || level >= 2),
    ).toEqual([]);
  });
});
