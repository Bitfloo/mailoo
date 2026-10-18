import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parse } from 'yaml';

import { repoRoot } from './agents/agent-file.js';
import { lockPeerRange, nextMajor, peerCeiling } from './held-majors.js';

interface Update {
  'package-ecosystem': string;
  directory?: string;
  directories?: string[];
  groups?: Record<string, { 'update-types'?: string[]; 'exclude-patterns'?: string[] }>;
  ignore?: Record<string, unknown>[];
}

describe('dependabot groups', () => {
  const { updates } = parse(readFileSync(join(repoRoot, '.github/dependabot.yml'), 'utf8')) as {
    updates: Update[];
  };
  const groups = updates.flatMap((update) => Object.entries(update.groups ?? {}));

  function group(name: string): NonNullable<Update['groups']>[string] {
    const found = groups.find(([key]) => key === name);
    if (!found) {
      throw new Error(`missing group ${name}`);
    }
    return found[1];
  }

  const byName = (a: string[], b: string[]) => a[0].localeCompare(b[0]);

  /** Every ignore entry of every update, read whole and sorted by name. */
  function holds(): string[][] {
    return updates
      .flatMap((update) => update.ignore ?? [])
      .map((entry) => {
        const { 'dependency-name': name, versions, ...rest } = entry;
        const floor =
          Array.isArray(versions) && versions.length === 1
            ? String(versions[0]).match(/^>=(\d+\.\d+\.\d+)$/)?.[1]
            : undefined;
        return typeof name === 'string' && floor && Object.keys(rest).length === 0
          ? [name, floor]
          : [JSON.stringify(entry), 'not a lone >= floor'];
      })
      .sort(byName);
  }

  it('should keep every dependency still on 0.x out of its update group', () => {
    // Dependabot calls 0.25 → 0.27 a minor update, but on 0.x that can break the API (node-ical 0.27 did).
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<
      'dependencies' | 'devDependencies',
      Record<string, string>
    >;
    const onZero = (deps: Record<string, string>) =>
      Object.keys(deps)
        .filter((name) => /^[\^~]?0\./.test(deps[name]))
        .sort();
    const excluded = (name: string) => [...(group(name)['exclude-patterns'] ?? [])].sort();
    expect({
      production: excluded('production-dependencies'),
      development: excluded('dev-dependencies'),
    }).toEqual({
      production: onZero(manifest.dependencies),
      development: onZero(manifest.devDependencies),
    });
  });

  it('should update every npm manifest the repository tracks', () => {
    // With only / listed, the release npm CLI and the image pnpm CLI never got an update.
    const manifests = execFileSync('git', ['ls-files', '--', 'package.json', '**/package.json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((file) => `/${dirname(file)}`.replace(/\/\.$/, '/'));
    const covered = updates
      .filter((update) => update['package-ecosystem'] === 'npm')
      .flatMap((update) => update.directories ?? [update.directory]);
    expect(manifests.filter((dir) => !covered.includes(dir))).toEqual([]);
  });

  it('should hold each blocked major at the first version its holder rules out', () => {
    // A missing hold lets Dependabot open a major that breaks lint or the build. A hold at the
    // manifest's own major blocks that major's patches too. Every update is read: the tooling
    // CLI update holds nothing, so a hold added there has to be derived here as well.
    // Dependabot applies every entry, so a duplicate with a lower floor or an extra key such as
    // update-types changes what is held. Each entry is read whole and kept, not merged by name.
    const eslintCeiling = peerCeiling(lockPeerRange('eslint-config-airbnb-extended', 'eslint'));
    expect(holds()).toEqual(
      Object.entries({
        eslint: eslintCeiling,
        '@eslint/js': eslintCeiling,
        typescript: peerCeiling(lockPeerRange('typescript-eslint', 'typescript')),
        vite: nextMajor('vite'),
        '@types/node': nextMajor('@types/node'),
      }).sort(byName),
    );
  });

  it.each(['~9.0.0', '9.0.0'])('should refuse %j as a peer range with no ceiling', (range) => {
    expect(() => peerCeiling(range)).toThrow(`no ceiling in peer range ${range}`);
  });

  it('should keep a github-actions update at the root so the action SHA pins get bumps', () => {
    // Every uses: is pinned to a commit SHA, so without this update no pin would ever move.
    const actions = updates.filter((update) => update['package-ecosystem'] === 'github-actions');
    expect(actions.map((update) => update.directory)).toEqual(['/']);
  });

  it('should group only minor and patch updates', () => {
    // A major can break the API, so it gets its own pull request instead of holding back a group.
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.map(([name, settings]) => [name, settings['update-types']])).toEqual(
      groups.map(([name]) => [name, ['minor', 'patch']]),
    );
  });
});
