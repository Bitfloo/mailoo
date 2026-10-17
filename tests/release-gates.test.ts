import { jobGate, runsJob } from './workflow-gates.js';
import { jobSections, releaseSteps, releaseYml } from './workflow-yaml.js';

function releaseJob(marker: string): string {
  const job = jobSections(releaseYml).find((section) => section.includes(marker));
  if (!job) {
    throw new Error(`no release job holds ${marker.trim()}`);
  }
  return job;
}

const stampJob = () => releaseJob('- name: Set version in server.json\n');
const dockerJob = () => releaseJob('goreleaser/goreleaser-action@');

describe('release job gate evaluator', () => {
  it.each([
    "    if: always() && github.ref_type == 'tag' && (needs.npm.result == 'success')",
    "    if: always() && inputs.version != '' && (needs.npm.result == 'success')",
    "    if: >-\n      always() &&\n      github.event_name == 'push'",
    "    if: success() && needs.npm.result == 'success'",
    "    if: needs.npm.result != 'failure'",
    "    if: needs.lint.result == 'success'",
    '    if: always() always()',
  ])('should refuse to evaluate %j as a release job gate', (job) => {
    expect(() => runsJob(jobGate(job), { npm: 'success' })).toThrow(/unsupported gate/);
  });

  it.each([
    { job: "    if: needs.npm.result == 'success'", npm: 'success', runs: true },
    { job: "    if: needs.npm.result == 'skipped'", npm: 'skipped', runs: false },
    {
      job: "    if: needs.npm.result == 'failure' || always() && needs.npm.result == 'skipped'",
      npm: 'failure',
      runs: true,
    },
    {
      job: "    if: (needs.npm.result == 'skipped' || always()) && needs.npm.result == 'failure'",
      npm: 'skipped',
      runs: false,
    },
    {
      job: "    if: >-\n      always() &&\n      needs.npm.result == 'skipped'",
      npm: 'skipped',
      runs: true,
    },
    {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub expression, not a JS template
      job: "    if: ${{ always() && needs.npm.result == 'cancelled' }}",
      npm: 'cancelled',
      runs: true,
    },
  ])('should evaluate $job to $runs when npm is $npm', ({ job, npm, runs }) => {
    expect(runsJob(jobGate(job), { npm })).toBe(runs);
  });
});

describe('release job gates', () => {
  // A tag push publishes to npm first, and skip-npm skips that job on a manual run. Both must
  // reach the registry; a failed or cancelled npm publish must stop it.
  it.each(['success', 'skipped'])('should publish to the MCP Registry when npm is %s', (npm) => {
    expect(runsJob(jobGate(stampJob()), { npm })).toBe(true);
  });

  it.each(['failure', 'cancelled'])(
    'should not publish to the MCP Registry when npm is %s',
    (npm) => {
      expect(runsJob(jobGate(stampJob()), { npm })).toBe(false);
    },
  );

  it.each(['success', 'skipped'])(
    'should publish Docker images when npm is %s and MCP succeeded',
    (npm) => {
      expect(runsJob(jobGate(dockerJob()), { npm, mcp: 'success' })).toBe(true);
    },
  );

  it.each(['failure', 'cancelled'])('should not publish Docker images when npm is %s', (npm) => {
    expect(runsJob(jobGate(dockerJob()), { npm, mcp: 'success' })).toBe(false);
  });

  it.each(['failure', 'cancelled', 'skipped'])(
    'should not publish Docker images when MCP is %s',
    (mcp) => {
      // The GitHub release and images would then name a version the registry does not have.
      expect(runsJob(jobGate(dockerJob()), { npm: 'success', mcp })).toBe(false);
    },
  );

  it('should keep continue-on-error off every release job and step', () => {
    // needs.<job>.result reads success after a failure that continue-on-error let through, so the
    // gates above would publish past a failed npm or MCP publish.
    expect(releaseSteps(releaseYml)).not.toMatch(/^\s*continue-on-error:/m);
  });

  it('should make the job that stamps server.json need npm when its if: reads the npm result', () => {
    // Without needs, needs.npm.result is empty, so the if: never passes and nothing is published.
    expect(stampJob()).toContain('needs: [npm]');
  });

  it('should make the Docker job need npm and MCP when its if: reads both results', () => {
    expect(dockerJob()).toContain('needs: [npm, mcp]');
  });
});
