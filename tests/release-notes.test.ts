import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';
import { changelogMd, swapOnce } from './changelog-fixture.js';
import {
  jobSections,
  readKeyLines,
  refEnv,
  releaseStep,
  releaseSteps,
  releaseYml,
  stepEnv,
} from './workflow-yaml.js';

/** The step's `run: |` block, dedented, as the runner would execute it. */
function runBlock(step: string): string {
  const match = step.match(/\n {8}run: \|\n((?: {10}.*(?:\n|$)|\n)+)/);
  if (!match) {
    throw new Error('step has no run block');
  }
  return match[1].replace(/^ {10}/gm, '');
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
        ...refEnv(run.ref),
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
  it('should run the whole run block, blank lines included', () => {
    const step = '- name: Example\n        run: |\n          true\n\n          false\n';
    expect(runBlock(step)).toBe('true\n\nfalse\n');
  });

  it('should use the CHANGELOG.md section of the tag as the release body when a tag is pushed', () => {
    const section = changelogSection('v0.2.0');
    expect(section).toMatch(/^#### ✨ Features\n- add export_email tool/);
    expect(notesBeforeInstall(releaseNotes({ ref: 'refs/tags/v0.2.0' }))).toBe(section);
  });

  it('should use the CHANGELOG.md section of the version input when run by hand', () => {
    const notes = releaseNotes({ ref: 'refs/heads/develop', inputVersion: '0.1.8' });
    expect(notesBeforeInstall(notes)).toBe(changelogSection('v0.1.8'));
  });

  it('should not take a newer release when its version starts with the same digits', () => {
    const changelog = swapOnce(changelogMd, '\n## [v0.2.0](', '\n## [v0.1.10](');
    const notes = releaseNotes({ ref: 'refs/tags/v0.1.1', changelog });
    expect(notesBeforeInstall(notes)).toBe(changelogSection('v0.1.1'));
  });

  it('should not start the release body at a newer bullet that quotes its heading', () => {
    const changelog = swapOnce(
      changelogMd,
      '- bind the export size limit to one constant - (',
      '- quote ## [v0.1.8]( in a subject - (',
    );
    const notes = releaseNotes({ ref: 'refs/tags/v0.1.8', changelog });
    expect(notesBeforeInstall(notes)).toBe(changelogSection('v0.1.8'));
  });

  it('should keep a bullet whose subject holds the entry separator', () => {
    const subject = (text: string) =>
      swapOnce(
        text,
        '- bind the export size limit to one constant - (',
        '- keep - - - in a subject - (',
      );
    const notes = releaseNotes({ ref: 'refs/tags/v0.2.0', changelog: subject(changelogMd) });
    expect(notesBeforeInstall(notes)).toBe(subject(changelogSection('v0.2.0')));
  });

  it('should give only the install lines when a release holds only omitted commit types', () => {
    // cog 7 writes the heading with an empty body when every commit type in the range is omitted.
    // The empty entry goes above whichever entry is newest, under a version no release takes:
    // anchored on v0.2.0, this test failed the push of the v0.2.1 bump that moved it down.
    const changelog = swapOnce(
      changelogMd,
      '\n- - -\n## [',
      '\n- - -\n## [v9.9.9](https://github.com/bitfloo/mailoo/compare/v9.9.8..v9.9.9) - 2026-10-17\n\n- - -\n## [',
    );
    expect(notesBeforeInstall(releaseNotes({ ref: 'refs/tags/v9.9.9', changelog }))).toBe('');
  });

  it('should stop the release when CHANGELOG.md is missing', () => {
    expect(() => releaseNotes({ ref: 'refs/tags/v0.2.0', changelog: null })).toThrow(
      /(?:can't|cannot) open/,
    );
  });

  it('should stop the release when CHANGELOG.md has no section for the version', () => {
    // A mistyped version on a manual run would otherwise publish a release with an empty body.
    expect(() => releaseNotes({ ref: 'refs/heads/develop', inputVersion: '0.9.9' })).toThrow(
      /no CHANGELOG\.md section for ## \[v0\.9\.9\]\(/,
    );
  });

  it('should keep a blank line before the install lines when the section ends without one', () => {
    // Without it the install line would continue the last bullet.
    const bullet = 'e7d12dc01f1dd8690690dcced9a4fa767dbc11f6)) - Mike\n';
    const changelog = swapOnce(changelogMd, `${bullet}\n- - -\n`, `${bullet}- - -\n`);
    expect(releaseNotes({ ref: 'refs/tags/v0.2.0', changelog })).toContain(
      `${bullet}\n**Install:**`,
    );
  });

  it('should end the release body with the install commands for that version', () => {
    const notes = releaseNotes({ ref: 'refs/tags/v0.2.0' });
    expect(notes.trimEnd().split('\n').slice(-3)).toEqual([
      '**Install:** `npx -y @bitfloo/mailoo@0.2.0` · `docker pull ghcr.io/bitfloo/mailoo:0.2.0` (or `0.2.0-alpine`)',
      '',
      'Full history: [CHANGELOG.md](https://github.com/bitfloo/mailoo/blob/v0.2.0/CHANGELOG.md)',
    ]);
  });

  it('should hand the written release body to GoReleaser', () => {
    expect(releaseStep(releaseYml, 'Write release notes')).toContain(
      'notes="$RUNNER_TEMP/release-notes.md"',
    );
    expect(releaseStep(releaseYml, 'Run GoReleaser')).toMatch(
      /^ +args: release --clean --release-notes=\$\{\{ runner\.temp \}\}\/release-notes\.md$/m,
    );
  });

  it('should replace the body of a release that already exists', () => {
    // A re-run or a manual dispatch for a tag that already has a release would otherwise keep the old body.
    const goreleaser = readFileSync(join(repoRoot, '.goreleaser.yaml'), 'utf8');
    expect(goreleaser).toMatch(/^release:\n(?: {2}.*\n)*? {2}mode: replace$/m);
  });

  const dockerJob = () => {
    const job = jobSections(releaseSteps(releaseYml)).find((section) =>
      section.includes('goreleaser/goreleaser-action@'),
    );
    if (!job) {
      throw new Error('release.yml has no GoReleaser job');
    }
    return job;
  };

  it('should run only the docker setup actions between the checkout and the release notes', () => {
    // Another checkout or a run step there could hand the notes step another CHANGELOG.md or none.
    const job = dockerJob();
    const before = job.slice(
      job.indexOf('- uses: actions/checkout@'),
      job.indexOf('- name: Write release notes\n'),
    );
    expect(
      before.split(/\n {6}- /).map((step) => step.match(/uses: ([\w-]+\/[\w-]+)@/)?.[1] ?? step),
    ).toEqual([
      'actions/checkout',
      'docker/setup-qemu-action',
      'docker/setup-buildx-action',
      'docker/login-action',
    ]);
  });

  it('should read CHANGELOG.md from a full, unconditional checkout of the release commit', () => {
    const job = dockerJob();
    const checkout = job.slice(job.indexOf('- uses: actions/checkout@'));
    // ref, repository, path or sparse-checkout would hand the step another CHANGELOG.md or none.
    expect(checkout.slice(0, checkout.indexOf('\n      - ')).split('\n').slice(1)).toEqual([
      '        with:',
      '          fetch-depth: 0',
    ]);
  });

  it('should write the release notes right before GoReleaser reads them', () => {
    // A step in between could rewrite the file GoReleaser publishes as the release body.
    const written = releaseStep(releaseYml, 'Write release notes');
    const job = dockerJob();
    expect(job.slice(job.indexOf(written) + written.length)).toMatch(
      /^\n {6}- name: Run GoReleaser\n/,
    );
  });

  it('should run the release-notes step with the default shell in the checkout root', () => {
    // The harness above runs it that way: `bash -e` in the directory that holds CHANGELOG.md.
    const step = releaseStep(releaseYml, 'Write release notes');
    expect(readKeyLines(step, 'shell|working-directory')).toEqual([]);
  });

  it('should set no run defaults the release-notes harness does not model', () => {
    expect(readKeyLines(releaseYml, 'defaults')).toEqual([]);
  });
});
