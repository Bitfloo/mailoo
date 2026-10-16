import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const omitted = [
    ...cogToml.matchAll(/^\w+ = \{ changelog_title = "([^"]+)", omit_from_changelog = true \}$/gm),
  ].map((match) => match[1]);

  function tidy(changelog: string, latest: string, version: string): string {
    const temp = mkdtempSync(join(tmpdir(), 'mailoo-changelog-entry-'));
    try {
      writeFileSync(join(temp, 'CHANGELOG.md'), changelog);
      execFileSync('bash', [join(repoRoot, 'scripts/tidy-changelog-entry.sh'), latest, version], {
        cwd: temp,
        env: { PATH: process.env.PATH },
      });
      return readFileSync(join(temp, 'CHANGELOG.md'), 'utf8');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }

  it('should turn the entry cog wrote for v0.2.0 into the published one', () => {
    const published = changelogMd.match(/^## \[v0\.2\.0\].*$/m)?.[0] ?? '';
    const raw = swapOnce(
      swapOnce(changelogMd, published, cogHeading),
      ' - Mike, michal, Cursor Agent\n',
      ` - ${cogAuthors}\n`,
    );
    expect(tidy(raw, '0.1.8', '0.2.0')).toBe(changelogMd);
  });

  it('hides commit types with the key cog 7 reads', () => {
    // cog 7 ignores `hidden = true`; v0.2.0 shipped Build and CI sections because of it.
    expect(cogToml).not.toMatch(/^\w+ = \{[^}]*\bhidden\s*=/m);
  });

  it('omits build, CI, test, style and chore commits from the changelog', () => {
    // The test below reads this list from cog.toml, so a dropped key would shrink what it checks.
    expect([...omitted].sort()).toEqual(['Build', 'CI', 'Chores', 'Styles', 'Tests']);
  });

  it('keeps every omitted commit type out of the published Mailoo releases', () => {
    const mailoo = changelogMd.slice(0, changelogMd.indexOf('\n## Upstream history'));
    const titles = [...mailoo.matchAll(/^#### (.+)$/gm)].map((match) => match[1]);
    expect(titles.filter((title) => omitted.includes(title))).toEqual([]);
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
