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
  schedule?: Record<string, string>;
  'open-pull-requests-limit'?: number;
  groups?: Record<
    string,
    {
      'dependency-type'?: string;
      patterns?: string[];
      'update-types'?: string[];
      'exclude-patterns'?: string[];
    }
  >;
  ignore?: Record<string, unknown>[];
}

describe('dependabot groups', () => {
  const config = parse(readFileSync(join(repoRoot, '.github/dependabot.yml'), 'utf8')) as {
    version: unknown;
    updates: Update[];
  };
  const { updates } = config;
  const groups = updates.flatMap((update) => Object.entries(update.groups ?? {}));

  function group(name: string): NonNullable<Update['groups']>[string] {
    const found = groups.find(([key]) => key === name);
    if (!found) {
      throw new Error(`missing group ${name}`);
    }
    return found[1];
  }

  const byName = (a: string[], b: string[]) => a[0].localeCompare(b[0]);

  /** Each update root, as dependabot.yml writes it, of the tracked files git lists for `patterns`. */
  function trackedDirs(patterns: string[]): string[] {
    return execFileSync('git', ['ls-files', '--', ...patterns], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map((file) => `/${dirname(file)}`.replace(/\/\.$/, '/'));
  }

  const dockerfiles = ['Dockerfile', 'Dockerfile.*', '**/Dockerfile', '**/Dockerfile.*'];

  function covered(ecosystem: string): (string | undefined)[] {
    return updates
      .filter((update) => update['package-ecosystem'] === ecosystem)
      .flatMap((update) => update.directories ?? [update.directory]);
  }

  /** The major after the one every tracked Dockerfile's node base image runs. */
  function nextImageMajor(): string {
    const majors = new Set(
      execFileSync('git', ['ls-files', '--', ...dockerfiles], { cwd: repoRoot, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .flatMap((file) => {
          // Every FROM naming node is read, in any case as Docker reads it, so a form the major
          // pattern misses throws instead of leaving the hold to the other Dockerfiles.
          const tags = [
            ...readFileSync(join(repoRoot, file), 'utf8').matchAll(/^FROM\s.*\bnode:(\S+)/gim),
          ].map(([, tag]) => tag);
          if (tags.length === 0) {
            throw new Error(`${file}: no FROM names a node image`);
          }
          return tags.map((tag) => {
            const major = tag.match(/^(\d+)-/)?.[1];
            if (!major) {
              throw new Error(`${file}: node:${tag} names no major`);
            }
            return major;
          });
        }),
    );
    if (majors.size !== 1) {
      throw new Error(`expected one node major across the Dockerfiles, got ${[...majors]}`);
    }
    return `${Number([...majors][0]) + 1}.0.0`;
  }

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
    const npm = covered('npm');
    expect(
      trackedDirs(['package.json', '**/package.json']).filter((dir) => !npm.includes(dir)),
    ).toEqual([]);
  });

  it('should update the base image of every Dockerfile the repository tracks', () => {
    // The FROM lines pin node by digest, so a Dockerfile no docker update covers never moves.
    const dirs = trackedDirs(dockerfiles);
    const docker = covered('docker');
    expect({ read: dirs.length > 0, missing: dirs.filter((dir) => !docker.includes(dir)) }).toEqual(
      { read: true, missing: [] },
    );
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
        node: nextImageMajor(),
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

  it('should run each update weekly on Monday with its pinned pull request limit', () => {
    // A limit of 0 would stop that entry's version updates; a higher limit or a shorter interval
    // would open more update pull requests at once.
    const weekly = { interval: 'weekly', day: 'monday' };
    expect(
      updates.map((update) => [
        update['package-ecosystem'],
        update.directories ?? [update.directory],
        update.schedule,
        update['open-pull-requests-limit'],
      ]),
    ).toEqual([
      ['npm', ['/'], weekly, 10],
      ['npm', ['/.github/npm-cli', '/docker/pnpm-cli'], weekly, 2],
      ['github-actions', ['/'], weekly, 5],
      ['docker', ['/'], weekly, 2],
    ]);
  });

  it('should set only version and updates at the top of dependabot.yml', () => {
    // A top-level registries or enable-beta-ecosystems key would change where or what it updates.
    expect(Object.keys(config).sort()).toEqual(['updates', 'version']);
  });

  it('should use the version 2 config format', () => {
    expect(config.version).toBe(2);
  });

  it('should set only the pinned keys on each dependabot update and group', () => {
    // Any other key changes what Dependabot opens: target-branch would aim at a branch this
    // repository does not have, versioning-strategy lockfile-only would stop manifest bumps,
    // allow would narrow the updates, cooldown would delay them, rebase-strategy disabled would
    // leave them stale, insecure-external-code-execution would run package code, and applies-to
    // on a group would move it to security updates.
    expect(
      updates.map((update) => ({
        keys: Object.keys(update).sort(),
        groups: Object.fromEntries(
          Object.entries(update.groups ?? {}).map(([name, settings]) => [
            name,
            Object.keys(settings).sort(),
          ]),
        ),
      })),
    ).toEqual([
      {
        keys: [
          'directory',
          'groups',
          'ignore',
          'open-pull-requests-limit',
          'package-ecosystem',
          'schedule',
        ],
        groups: {
          'dev-dependencies': ['dependency-type', 'update-types'],
          'production-dependencies': ['dependency-type', 'exclude-patterns', 'update-types'],
        },
      },
      {
        keys: ['directories', 'open-pull-requests-limit', 'package-ecosystem', 'schedule'],
        groups: {},
      },
      {
        keys: ['directory', 'groups', 'open-pull-requests-limit', 'package-ecosystem', 'schedule'],
        groups: { 'github-actions': ['patterns', 'update-types'] },
      },
      {
        keys: ['directory', 'ignore', 'open-pull-requests-limit', 'package-ecosystem', 'schedule'],
        groups: {},
      },
    ]);
  });

  it('should split the npm groups by dependency type', () => {
    // Swapped, the 0.x exclusions would guard the development group and leave the production
    // 0.x packages in a group.
    const type = (name: string) => group(name)['dependency-type'];
    expect([type('dev-dependencies'), type('production-dependencies')]).toEqual([
      'development',
      'production',
    ]);
  });

  it('should put every action in the github-actions group', () => {
    // A narrower pattern would leave the other actions out of the group.
    expect(group('github-actions').patterns).toEqual(['*']);
  });

  it('should group only minor and patch updates', () => {
    // A major can break the API, so it gets its own pull request instead of holding back a group.
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.map(([name, settings]) => [name, settings['update-types']])).toEqual(
      groups.map(([name]) => [name, ['minor', 'patch']]),
    );
  });
});

// Dependabot and the dependency graph read the first YAML document only. A pnpm-lock.yaml that
// opens with pnpm's own env lock shows them pnpm alone, and every alert closes without a word.
describe('pnpm lockfile Dependabot can read', () => {
  it('should keep pnpm-lock.yaml one YAML document', () => {
    const lockfile = readFileSync(join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
    expect(lockfile.match(/^---$/gm) ?? []).toEqual([]);
    expect(lockfile).toMatch(/^importers:\n\n {2}\.:\n {4}dependencies:/m);
  });
});
