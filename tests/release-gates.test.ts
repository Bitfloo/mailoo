import { jobGate, runsJob } from './workflow-gates.js';
import { jobSections, onBlock, releaseSteps, releaseYml } from './workflow-yaml.js';

function releaseJob(marker: string): string {
  const job = jobSections(releaseYml).find((section) => section.includes(marker));
  if (!job) {
    throw new Error(`no release job holds ${marker.trim()}`);
  }
  return job;
}

const npmJob = () => releaseJob('npm publish --access public');
const stampJob = () => releaseJob('- name: Set version in server.json\n');
const dockerJob = () => releaseJob('goreleaser/goreleaser-action@');

describe('release job gate evaluator', () => {
  it.each([
    "    if: always() && github.ref_type == 'tag' && (needs.npm.result == 'success')",
    "    if: always() && inputs.version != '' && (needs.npm.result == 'success')",
    "    if: >-\n      always() &&\n      github.event_name == 'push'",
    "    if: success() && needs.npm.result == 'success'",
    "    if: needs.npm.result >= 'success'",
    "    if: needs.lint.result == 'success'",
    '    if: always() always()',
  ])('should refuse to evaluate %j as a release job gate', (job) => {
    expect(() => runsJob(jobGate(job), { npm: 'success' })).toThrow(/unsupported gate/);
  });

  it.each<{ job: string; needs: Record<string, string>; runs: boolean }>([
    { job: "    if: needs.npm.result == 'success'", needs: { npm: 'success' }, runs: true },
    { job: "    if: needs.npm.result == 'skipped'", needs: { npm: 'skipped' }, runs: false },
    {
      job: "    if: needs.npm.result == 'success' && needs.mcp.result == 'skipped'",
      needs: { npm: 'success', mcp: 'skipped' },
      runs: false,
    },
    {
      job: "    if: needs.npm.result == 'failure' || always() && needs.npm.result == 'skipped'",
      needs: { npm: 'failure' },
      runs: true,
    },
    {
      job: "    if: (needs.npm.result == 'skipped' || always()) && needs.npm.result == 'failure'",
      needs: { npm: 'skipped' },
      runs: false,
    },
    {
      job: "    if: >-\n      always() &&\n      needs.npm.result == 'skipped'",
      needs: { npm: 'skipped' },
      runs: true,
    },
    {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub expression, not a JS template
      job: "    if: ${{ always() && needs.npm.result == 'cancelled' }}",
      needs: { npm: 'cancelled' },
      runs: true,
    },
  ])('should evaluate $job to $runs when the needed jobs are $needs', ({ job, needs, runs }) => {
    expect(runsJob(jobGate(job), needs)).toBe(runs);
  });

  it.each<{ job: string; context: Record<string, string | boolean>; runs: boolean }>([
    {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub expression, not a JS template
      job: '    if: ${{ !inputs.skip-npm }}',
      context: { 'inputs.skip-npm': true },
      runs: false,
    },
    {
      job: "    if: github.event_name != 'push'",
      context: { 'github.event_name': 'push' },
      runs: false,
    },
  ])('should evaluate $job to $runs when the context is $context', ({ job, context, runs }) => {
    expect(runsJob(jobGate(job), {}, context)).toBe(runs);
  });
});

describe('release job gates', () => {
  // On a push the inputs context is empty, so inputs.skip-npm reads as false.
  it.each([
    { run: 'a tag push', event: 'push', skip: false },
    { run: 'a manual run without skip-npm', event: 'workflow_dispatch', skip: false },
  ])('should publish to npm on $run', ({ event, skip }) => {
    const context = { 'github.event_name': event, 'inputs.skip-npm': skip };
    expect(runsJob(jobGate(npmJob()), {}, context)).toBe(true);
  });

  it('should not publish to npm on a manual run with skip-npm', () => {
    const context = { 'github.event_name': 'workflow_dispatch', 'inputs.skip-npm': true };
    expect(runsJob(jobGate(npmJob()), {}, context)).toBe(false);
  });

  it('should release on v* tags and on manual dispatch', () => {
    expect(onBlock(releaseYml)).toMatch(
      /^ {2}push:\n {4}tags:\n {6}- "v\*"\n {2}workflow_dispatch:\n/,
    );
  });

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
    // gates above would publish past a failed npm or MCP publish. A step that continued past a
    // refused stamp would publish server.json unstamped.
    expect(releaseSteps(releaseYml)).not.toMatch(/^\s*continue-on-error:/m);
  });

  it('should make the job that stamps server.json need npm when its if: reads the npm result', () => {
    // Without needs, needs.npm.result is empty, so the if: never passes and nothing is published.
    expect(stampJob()).toContain('needs: [npm]');
  });

  it('should run every step of the job that stamps server.json whenever the job runs', () => {
    // A tag push and a manual run both publish, so a step-level if: would skip the stamp, the login
    // or the publish on one of them.
    expect(stampJob()).not.toMatch(/^ {8}if:/m);
  });

  it('should make the Docker job need npm and MCP when its if: reads both results', () => {
    expect(dockerJob()).toContain('needs: [npm, mcp]');
  });
});
