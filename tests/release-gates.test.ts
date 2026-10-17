import { jobSections, releaseYml } from './workflow-yaml.js';

/** A job's own if:, folded lines included. */
function jobIf(job: string): string {
  return job.match(/^ {4}if:.*(?:\n {6,}\S.*)*/m)?.[0] ?? '';
}

/** A job gate that reads the event, the ref or an input lets only some kinds of release through. */
const readsReleaseKind = /\b(?:github|inputs)\s*[.[]/;

function stampJob(): string {
  const job = jobSections(releaseYml).find((section) =>
    section.includes('- name: Set version in server.json\n'),
  );
  if (!job) {
    throw new Error('no release job runs Set version in server.json');
  }
  return job;
}

describe('release version selection', () => {
  it.each([
    "    if: always() && github.ref_type == 'tag' && (needs.npm.result == 'success')",
    "    if: always() && inputs.version != '' && (needs.npm.result == 'success')",
    "    if: >-\n      always() &&\n      github.event_name == 'push'",
  ])('should flag %j as a job gate on the kind of release', (job) => {
    expect(jobIf(job)).toMatch(readsReleaseKind);
  });

  it('should pass a gate on the npm result as one every kind of release gets through', () => {
    const gate =
      "    if: always() && (needs.npm.result == 'success' || needs.npm.result == 'skipped')";
    expect(jobIf(gate)).not.toMatch(readsReleaseKind);
  });

  it('should not gate the job that stamps server.json on the kind of release', () => {
    expect(jobIf(stampJob())).not.toMatch(readsReleaseKind);
  });

  it('should run the job that stamps server.json when a manual run skips npm', () => {
    // skip-npm skips the npm job, and a job that needs it is skipped too unless its if: says always().
    expect(jobIf(stampJob())).toMatch(/^(?=.*\balways\(\))(?=.*needs\.npm\.result == 'skipped')/s);
  });

  it('should make the job that stamps server.json need npm when its if: reads the npm result', () => {
    // Without needs, needs.npm.result is empty, so the if: never passes and nothing is published.
    expect(stampJob()).toContain('needs: [npm]');
  });
});
