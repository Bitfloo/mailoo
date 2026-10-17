import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';
import { lockPeerRange, nextMajor, peerCeiling } from './held-majors.js';

describe('dependabot groups', () => {
  const config = readFileSync(join(repoRoot, '.github/dependabot.yml'), 'utf8');
  /** Each group's name and settings, read as text: the repo has no YAML parser, so lists stay inline and double-quoted. */
  const groups = [...config.matchAll(/^ {6}([\w-]+):\n((?: {8}.*\n)+)/gm)].map(
    (match) => [match[1], match[2]] as const,
  );

  function group(name: string): string {
    const found = groups.find(([key]) => key === name);
    if (!found) {
      throw new Error(`missing group ${name}`);
    }
    return found[1];
  }

  /** Each npm update entry. GitHub's own examples quote the ecosystem name, so quoted, bare and commented forms count. */
  function npmUpdates(yaml: string): string[] {
    const updates = yaml
      .split(/\n {2}- package-ecosystem: /)
      .filter((entry) => /^(["']?)npm\1[ \t]*(?:#.*)?\n/.test(entry));
    // An update this reader skips holds nothing it can see, so each one must be read as npm or github-actions.
    const all = yaml.match(/^[ \t]*- package-ecosystem:/gm)?.length ?? 0;
    const actions =
      yaml.match(/^ {2}- package-ecosystem: (["']?)github-actions\1[ \t]*(?:#.*)?$/gm)?.length ?? 0;
    if (updates.length + actions !== all) {
      throw new Error(`read ${updates.length} npm and ${actions} github-actions of ${all} updates`);
    }
    return updates;
  }

  const byName = (a: string[], b: string[]) => a[0].localeCompare(b[0]);

  /** Every ignore entry of every npm update, read whole and sorted by name. */
  function npmHolds(yaml: string): string[][] {
    const updates = npmUpdates(yaml).join('\n');
    const code = yaml
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    // A list in flow style, at its key indent or outside an npm update holds packages this reader never sees.
    const keys = code.match(/^[ \t]*(?:- )?["']?ignore["']?[ \t]*:/gm)?.length ?? 0;
    const lists = updates.match(/^ {4}ignore:\n {6}/gm)?.length ?? 0;
    if (lists !== keys) {
      throw new Error(`read ${lists} of ${keys} ignore lists`);
    }
    const held = [...updates.matchAll(/^ {4}ignore:\n((?: {6}.*\n?)+)/gm)]
      .flatMap(([, list]) => list.split(/^(?= {6}- )/m))
      .map((entry) =>
        entry
          .split('\n')
          .filter((line) => line.trim() && !line.trim().startsWith('#'))
          .join('\n'),
      )
      .filter(Boolean)
      .map((entry) => {
        const plain = entry.match(
          /^ {6}- dependency-name: "([^"]+)"\n {8}versions: \[">=(\d+\.\d+\.\d+)"\]$/,
        );
        return plain ? [plain[1], plain[2]] : [entry.trim(), 'not a lone >= floor'];
      })
      .sort(byName);
    // A name in a flow mapping or under another key is one this reader never sees, so every name must be read.
    const names = code.match(/dependency-name["']?[ \t]*:/g)?.length ?? 0;
    if (held.length !== names) {
      throw new Error(`read ${held.length} of ${names} ignore entries`);
    }
    return held;
  }

  it('should read an npm update whether its ecosystem name is quoted or followed by a comment', () => {
    const yaml = [
      'updates:',
      '  - package-ecosystem: npm',
      '    directory: /',
      '  - package-ecosystem: "npm"',
      '    directory: /a',
      "  - package-ecosystem: 'npm'",
      '    directory: /b',
      '  - package-ecosystem: npm # tooling',
      '    directory: /c',
      '  - package-ecosystem: github-actions',
      '    directory: /',
    ].join('\n');
    expect(npmUpdates(yaml).map((entry) => entry.match(/directory: (\S+)/)?.[1])).toEqual([
      '/',
      '/a',
      '/b',
      '/c',
    ]);
  });

  it('should refuse a config when an update sits where the reader does not look', () => {
    const yaml = ['updates:', '    - package-ecosystem: npm', '      directory: /'].join('\n');
    expect(() => npmUpdates(yaml)).toThrow('read 0 npm and 0 github-actions of 1 updates');
  });

  it('should refuse a config when an ignore list sits at its key indent', () => {
    const yaml = [
      'updates:',
      '  - package-ecosystem: npm',
      '    directory: /',
      '    ignore:',
      '    - dependency-name: "pnpm"',
      '      versions: [">=1.0.0"]',
    ].join('\n');
    expect(() => npmHolds(yaml)).toThrow('read 0 of 1 ignore lists');
  });

  it.each([
    { block: 'an npm', ecosystem: 'npm', name: 'vite' },
    { block: 'the github-actions', ecosystem: 'github-actions', name: 'actions/checkout' },
  ])(
    'should refuse a config when an ignore list in $block block is written in flow style',
    ({ ecosystem, name }) => {
      const yaml = [
        'updates:',
        '  - package-ecosystem: npm',
        '    directory: /a',
        `  - package-ecosystem: ${ecosystem}`,
        '    directory: /',
        `    ignore: [{ dependency-name: "${name}", versions: [">=8.0.0"] }]`,
      ].join('\n');
      expect(() => npmHolds(yaml)).toThrow('read 0 of 1 ignore lists');
    },
  );

  it('should refuse a config when a dependency name sits in a flow mapping under another key', () => {
    const yaml = [
      'updates:',
      '  - package-ecosystem: npm',
      '    directory: /',
      '    allow: [{ dependency-name: "vite" }]',
    ].join('\n');
    expect(() => npmHolds(yaml)).toThrow('read 0 of 1 ignore entries');
  });

  it('keeps every dependency still on 0.x out of its update group', () => {
    // Dependabot calls 0.25 → 0.27 a minor update, but on 0.x that can break the API (node-ical 0.27 did).
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<
      'dependencies' | 'devDependencies',
      Record<string, string>
    >;
    const onZero = (deps: Record<string, string>) =>
      Object.keys(deps)
        .filter((name) => /^[\^~]?0\./.test(deps[name]))
        .sort();
    const excluded = (name: string) => {
      const list = group(name).match(/^ {8}exclude-patterns: \[(.*)\]$/m)?.[1] ?? '';
      return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
    };
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
    const covered = npmUpdates(config).flatMap((entry) => {
      const list = entry.match(/^ {4}directories: \[(.*)\]$/m)?.[1];
      const single = entry.match(/^ {4}directory: (\S+)$/m)?.[1];
      return list ? [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]) : [single];
    });
    expect(manifests.filter((dir) => !covered.includes(dir))).toEqual([]);
  });

  it('should hold each blocked major at the first version its holder rules out', () => {
    // A missing hold lets Dependabot open a major that breaks lint or the build. A hold at the
    // manifest's own major blocks that major's patches too. Every npm update is read: the
    // tooling CLI update holds nothing, so a hold added there has to be derived here as well.
    // Dependabot applies every entry, so a duplicate with a lower floor or an extra key such as
    // update-types changes what is held. Each entry is read whole and kept, not merged by name.
    const eslintCeiling = peerCeiling(lockPeerRange('eslint-config-airbnb-extended', 'eslint'));
    expect(npmHolds(config)).toEqual(
      Object.entries({
        eslint: eslintCeiling,
        '@eslint/js': eslintCeiling,
        typescript: peerCeiling(lockPeerRange('typescript-eslint', 'typescript')),
        vite: nextMajor('vite'),
        '@types/node': nextMajor('@types/node'),
      }).sort(byName),
    );
  });

  it('groups only minor and patch updates', () => {
    // A major can break the API, so it gets its own pull request instead of holding back a group.
    expect(groups.length).toBeGreaterThan(0);
    expect(
      groups.map(([name, block]) => [name, block.match(/^ {8}update-types: (.*)$/m)?.[1]]),
    ).toEqual(groups.map(([name]) => [name, '[minor, patch]']));
  });
});
