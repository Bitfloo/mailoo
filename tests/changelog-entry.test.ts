import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';
import { changelogMd, swapOnce } from './changelog-fixture.js';

describe('cog changelog entry', () => {
  /** What cog 7.0.0 wrote for v0.2.0 (git show v0.2.0:CHANGELOG.md): a compare link from the range's first commit, one author per co-author line. */
  const cogHeading =
    '## [v0.2.0](https://github.com/bitfloo/mailoo/compare/e27fe33ad80a5bcd9b81fc959631aba33d0598e2..v0.2.0) - 2026-10-09';
  const cogAuthors = `Mike, ${Array.from({ length: 9 }, () => 'michal').join(', ')}, Cursor Agent`;
  const cogToml = readFileSync(join(repoRoot, 'cog.toml'), 'utf8');
  const commitTypes = cogToml.split(/^\[commit_types\]\n/m)[1]?.split(/^\[/m)[0] ?? '';
  const omitted = [...commitTypes.matchAll(/^(\w+) = \{(.*)\}$/gm)]
    .filter((match) => /\bomit_from_changelog = true\b/.test(match[2]))
    .map((match) => [match[1], match[2].match(/\bchangelog_title = "([^"]+)"/)?.[1] ?? '']);

  function runTidy(changelog: string, ...args: string[]): { changelog: string; files: string[] } {
    const temp = mkdtempSync(join(tmpdir(), 'mailoo-changelog-entry-'));
    try {
      writeFileSync(join(temp, 'CHANGELOG.md'), changelog);
      execFileSync('bash', [join(repoRoot, 'scripts/tidy-changelog-entry.sh'), ...args], {
        cwd: temp,
        env: { PATH: process.env.PATH },
        stdio: 'pipe',
      });
      return {
        changelog: readFileSync(join(temp, 'CHANGELOG.md'), 'utf8'),
        files: readdirSync(temp),
      };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  function tidy(changelog: string, latest: string, version: string): string {
    return runTidy(changelog, latest, version).changelog;
  }

  it('should turn the entry cog wrote for v0.2.0 into the published one', () => {
    const published = changelogMd.match(/^## \[v0\.2\.0\].*$/m)?.[0] ?? '';
    const raw = swapOnce(
      swapOnce(
        swapOnce(changelogMd, published, cogHeading),
        ' - Mike, michal, Cursor Agent\n',
        ` - ${cogAuthors}\n`,
      ),
      'e7d12dc01f1dd8690690dcced9a4fa767dbc11f6)) - Mike\n',
      'e7d12dc01f1dd8690690dcced9a4fa767dbc11f6)) - Mike, Mike\n',
    );
    expect(tidy(raw, '0.1.8', '0.2.0')).toBe(changelogMd);
  });

  it('should keep each author where they first appear', () => {
    const bullet = 'e7d12dc01f1dd8690690dcced9a4fa767dbc11f6)) - ';
    const raw = swapOnce(changelogMd, `${bullet}Mike\n`, `${bullet}Mike, Cursor Agent, Mike\n`);
    expect(tidy(raw, '0.1.8', '0.2.0')).toBe(
      swapOnce(changelogMd, `${bullet}Mike\n`, `${bullet}Mike, Cursor Agent\n`),
    );
  });

  it.each([
    ['quotes the entry heading', '- quote ## [v0.2.0]( in a subject - ('],
    ['holds the author separator', '- keep (a)) - b in a subject - ('],
    ['holds the entry separator', '- keep - - - in a subject - ('],
  ])('should list each author once on a bullet whose subject %s', (_, subject) => {
    const bullet = 'e7d12dc01f1dd8690690dcced9a4fa767dbc11f6)) - ';
    const published = swapOnce(
      changelogMd,
      '- bind the export size limit to one constant - (',
      subject,
    );
    const raw = swapOnce(published, `${bullet}Mike\n`, `${bullet}Mike, Mike\n`);
    expect(tidy(raw, '0.1.8', '0.2.0')).toBe(published);
  });

  it('should leave nothing but CHANGELOG.md behind', () => {
    expect(runTidy(changelogMd, '0.1.8', '0.2.0').files).toEqual(['CHANGELOG.md']);
  });

  it('should refuse to run without the latest version', () => {
    expect(() => runTidy(changelogMd)).toThrow(/latest version/);
  });

  it('should refuse to run without the new version', () => {
    expect(() => runTidy(changelogMd, '0.1.8')).toThrow(/\b2: version/);
  });

  it('hides commit types with the key cog 7 reads', () => {
    // cog 7 ignores `hidden = true`; v0.2.0 shipped Build and CI sections because of it.
    expect(cogToml).not.toMatch(/^\w+ = \{[^}]*\bhidden\s*=/m);
  });

  it('omits build, CI, test, style and chore commits from the changelog', () => {
    // The test below reads this list from cog.toml, so a dropped key would shrink what it checks.
    expect([...omitted].sort()).toEqual([
      ['build', 'Build'],
      ['chore', 'Chores'],
      ['ci', 'CI'],
      ['style', 'Styles'],
      ['test', 'Tests'],
    ]);
  });

  it('keeps every omitted commit type out of the published Mailoo releases', () => {
    const mailoo = changelogMd.slice(0, changelogMd.indexOf('\n## Upstream history'));
    const titles = [...mailoo.matchAll(/^#### (.+)$/gm)].map((match) => match[1]);
    const omittedTitles = omitted.map(([, title]) => title);
    expect(titles.filter((title) => omittedTitles.includes(title))).toEqual([]);
  });

  it('does not tidy a newer entry whose version starts with the same digits', () => {
    const raw = swapOnce(
      swapOnce(changelogMd, '\n## [v0.2.0](', '\n## [v0.1.10]('),
      ' - Mike, michal, Cursor Agent\n',
      ' - Mike, Mike, michal, Cursor Agent\n',
    );
    expect(tidy(raw, '0.1.0', '0.1.1')).toBe(raw);
  });

  it('should leave the other entries as they are', () => {
    // Older entries keep whatever link and authors they have; only the release being cut is rewritten.
    const raw = swapOnce(
      swapOnce(changelogMd, '/compare/v0.1.7..v0.1.8)', '/compare/0123abc..v0.1.8)'),
      '2d67d4416df9642ba060b2a7e7925077e381d7e8)) - Mike, Cursor\n',
      '2d67d4416df9642ba060b2a7e7925077e381d7e8)) - Mike, Mike, Cursor\n',
    );
    expect(tidy(raw, '0.1.8', '0.2.0')).toBe(raw);
  });
});
