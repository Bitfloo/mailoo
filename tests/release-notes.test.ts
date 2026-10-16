import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';
import { changelogMd, swapOnce } from './changelog-fixture.js';
import { jobSections, releaseStep, releaseSteps, releaseYml } from './workflow-yaml.js';

/** The step's `run: |` block, dedented, as the runner would execute it. */
function runBlock(step: string): string {
  const match = step.match(/\n {8}run: \|\n((?: {10}.*(?:\n|$))+)/);
  if (!match) {
    throw new Error('step has no run block');
  }
  return match[1].replace(/^ {10}/gm, '');
}

/** The step's `env:` block with each `${{ expression }}` filled in from `context`, as the runner does. */
function stepEnv(step: string, context: Record<string, string>): Record<string, string> {
  const block = step.match(/\n {8}env:\n((?: {10}\S.*\n)+)/)?.[1] ?? '';
  return Object.fromEntries(
    [...block.matchAll(/^ {10}(\w+): (.*)$/gm)].map(([, name, value]) => [
      name,
      value.replace(/\$\{\{ ([\w.-]+) \}\}/g, (_, expression: string) => {
        if (!(expression in context)) {
          throw new Error(`no value for ${expression}`);
        }
        return context[expression];
      }),
    ]),
  );
}

interface ReleaseRun {
  ref: string;
  /** GitHub passes an absent workflow_dispatch input as an empty string, so a tag push gets ''. */
  inputVersion?: string;
  /** CHANGELOG.md text to run against instead of the real file; null runs it where there is none. */
  changelog?: string | null;
}

/** Run the release-notes step with its own env wiring and return what it wrote. */
function releaseNotes(run: ReleaseRun): string {
  const step = releaseStep(releaseYml, 'Write release notes');
  const temp = mkdtempSync(join(tmpdir(), 'mailoo-release-notes-'));
  try {
    if (typeof run.changelog === 'string') {
      writeFileSync(join(temp, 'CHANGELOG.md'), run.changelog);
    }
    // A run step without `shell:` gets `bash -e {0}` on the runner: no -u, no pipefail.
    execFileSync('bash', ['-e', '-c', runBlock(step)], {
      cwd: run.changelog === undefined ? repoRoot : temp,
      env: {
        PATH: process.env.PATH,
        RUNNER_TEMP: temp,
        GITHUB_REF: run.ref,
        ...stepEnv(step, { 'inputs.version': run.inputVersion ?? '' }),
      },
      stdio: 'pipe',
    });
    return readFileSync(join(temp, 'release-notes.md'), 'utf8');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Cut by string search, not by the awk in release.yml, so a wrong awk boundary fails the tests. */
function changelogSection(tag: string): string {
  const heading = changelogMd.indexOf(`\n## [${tag}](`);
  if (heading < 0) {
    throw new Error(`CHANGELOG.md has no ${tag} section`);
  }
  const start = changelogMd.indexOf('\n', heading + 1) + 1;
  return changelogMd.slice(start, changelogMd.indexOf('\n- - -', start)).trim();
}

function notesBeforeInstall(notes: string): string {
  return notes.slice(0, notes.indexOf('\n**Install:**')).trim();
}

describe('release notes', () => {
  it('uses the CHANGELOG.md section of the pushed tag as the release body', () => {
    const section = changelogSection('v0.2.0');
    expect(section).toMatch(/^#### ✨ Features\n- add export_email tool/);
    expect(notesBeforeInstall(releaseNotes({ ref: 'refs/tags/v0.2.0' }))).toBe(section);
  });

  it('uses the CHANGELOG.md section of the version input on a manual run', () => {
    const notes = releaseNotes({ ref: 'refs/heads/develop', inputVersion: '0.1.8' });
    expect(notesBeforeInstall(notes)).toBe(changelogSection('v0.1.8'));
  });

  it('does not take a newer release whose version starts with the same digits', () => {
    const changelog = swapOnce(changelogMd, '\n## [v0.2.0](', '\n## [v0.1.10](');
    const notes = releaseNotes({ ref: 'refs/tags/v0.1.1', changelog });
    expect(notesBeforeInstall(notes)).toBe(changelogSection('v0.1.1'));
  });

  it('gives a release of omitted commit types only the install lines', () => {
    // cog 7 writes the heading with an empty body when every commit type in the range is omitted.
    const changelog = swapOnce(
      changelogMd,
      '\n- - -\n## [v0.2.0](',
      '\n- - -\n## [v0.2.1](https://github.com/bitfloo/mailoo/compare/v0.2.0..v0.2.1) - 2026-10-17\n\n- - -\n## [v0.2.0](',
    );
    expect(notesBeforeInstall(releaseNotes({ ref: 'refs/tags/v0.2.1', changelog }))).toBe('');
  });

  it('should stop the release when CHANGELOG.md is missing', () => {
    expect(() => releaseNotes({ ref: 'refs/tags/v0.2.0', changelog: null })).toThrow(
      /(?:can't|cannot) open/,
    );
  });

  it('ends the release body with install commands for that version', () => {
    const notes = releaseNotes({ ref: 'refs/tags/v0.2.0' });
    expect(notes.trimEnd().split('\n').slice(-3)).toEqual([
      '**Install:** `npx -y @bitfloo/mailoo@0.2.0` · `docker pull ghcr.io/bitfloo/mailoo:0.2.0` (or `0.2.0-alpine`)',
      '',
      'Full history: [CHANGELOG.md](https://github.com/bitfloo/mailoo/blob/v0.2.0/CHANGELOG.md)',
    ]);
  });

  it('hands the written release body to GoReleaser', () => {
    expect(releaseStep(releaseYml, 'Write release notes')).toContain(
      'notes="$RUNNER_TEMP/release-notes.md"',
    );
    expect(releaseStep(releaseYml, 'Run GoReleaser')).toMatch(
      /^ +args: release --clean --release-notes=\$\{\{ runner\.temp \}\}\/release-notes\.md$/m,
    );
  });

  const dockerJob =
    jobSections(releaseYml).find((job) => job.includes('goreleaser/goreleaser-action@')) ?? '';

  it('checks out the repository before it reads CHANGELOG.md', () => {
    const checkout = dockerJob.indexOf('- uses: actions/checkout@');
    expect(checkout).toBeGreaterThanOrEqual(0);
    expect(dockerJob.indexOf('- name: Write release notes\n')).toBeGreaterThan(checkout);
  });

  it('should read CHANGELOG.md from a full, unconditional checkout of the release commit', () => {
    const checkout = dockerJob.slice(dockerJob.indexOf('- uses: actions/checkout@'));
    // ref, repository, path or sparse-checkout would hand the step another CHANGELOG.md or none.
    expect(checkout.slice(0, checkout.indexOf('\n      - ')).split('\n').slice(1)).toEqual([
      '        with:',
      '          fetch-depth: 0',
    ]);
  });

  it.each([
    'Write release notes',
    'Run GoReleaser',
  ])('lets a failure in %s stop the release', (name) => {
    expect(releaseStep(releaseYml, name)).not.toMatch(/^ +(?:if|continue-on-error):/m);
  });

  it('writes the release notes before GoReleaser reads them', () => {
    const written = dockerJob.indexOf('- name: Write release notes\n');
    expect(written).toBeGreaterThanOrEqual(0);
    expect(dockerJob.indexOf('- name: Run GoReleaser\n')).toBeGreaterThan(written);
  });

  it('should run the release-notes step with the default shell in the checkout root', () => {
    // The harness above runs it that way: `bash -e` in the directory that holds CHANGELOG.md.
    expect(releaseStep(releaseYml, 'Write release notes')).not.toMatch(
      /^ +(?:shell|working-directory):/m,
    );
  });

  it('should set no run defaults the release-notes harness does not model', () => {
    expect(releaseSteps(releaseYml)).not.toMatch(/^ *defaults:/m);
  });

  it('should fail the release when a docker job step fails', () => {
    expect(dockerJob).not.toMatch(/^ {4}continue-on-error:/m);
  });
});
