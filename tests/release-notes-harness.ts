import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';
import { type Harness, harnessedStep, runBlock, runStep, stepEnv } from './workflow-yaml.js';

export const notesHarness: Harness = {
  workflow: 'release.yml',
  job: 'docker',
  steps: ['Write release notes'],
};

const step = harnessedStep(notesHarness, 'Write release notes');

export interface ReleaseRun {
  ref: string;
  /** GitHub passes an absent workflow_dispatch input as an empty string, so a tag push gets ''. */
  inputVersion?: string;
  /** CHANGELOG.md text to run against instead of the real file; null runs it where there is none. */
  changelog?: string | null;
}

/** Run the release-notes step with its own env wiring and return what it wrote. */
export function releaseNotes(run: ReleaseRun): string {
  const temp = mkdtempSync(join(tmpdir(), 'mailoo-release-notes-'));
  try {
    if (typeof run.changelog === 'string') {
      writeFileSync(join(temp, 'CHANGELOG.md'), run.changelog);
    }
    const { status, stderr } = runStep(
      runBlock(step),
      run.changelog === undefined ? repoRoot : temp,
      {
        PATH: process.env.PATH,
        RUNNER_TEMP: temp,
        GITHUB_REF: run.ref,
        ...stepEnv(step, { 'inputs.version': run.inputVersion ?? '' }),
      },
    );
    if (status !== 0) {
      throw new Error(stderr);
    }
    return readFileSync(join(temp, 'release-notes.md'), 'utf8');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
