import { parse } from 'yaml';

import { onBlock, readKeyLines, releaseSteps, workflowTexts } from './workflow-yaml.js';

const workflows = workflowTexts();

/**
 * Each workflow's on: block, comment lines stripped. A filter such as paths, paths-ignore, types
 * or another branch stops a run as surely as a missing trigger, so the whole block is pinned.
 */
const ON: Record<string, string[]> = {
  'ci.yml': [
    '  pull_request:',
    '    branches: [develop]',
    '  workflow_dispatch:',
    '    inputs:',
    '      include-unit:',
    '        description: Also run lint and unit tests (lefthook already does this)',
    '        type: boolean',
    '        default: false',
  ],
  'codeql.yml': [
    '  pull_request:',
    '    branches: [develop]',
    '  push:',
    '    branches: [develop]',
    '  schedule:',
    '    - cron: "17 5 * * 1"',
    '  workflow_dispatch:',
  ],
  'docker-sha.yml': ['  workflow_dispatch:'],
  // Another trigger would pass the npm gate as a run that is not a manual dispatch, and a string
  // skip-npm would make !inputs.skip-npm false on every manual run.
  'release.yml': [
    '  push:',
    '    tags:',
    '      - "v*"',
    '  workflow_dispatch:',
    '    inputs:',
    '      version:',
    '        description: >-',
    '          Version to release (e.g. 1.2.3) — used when',
    '          triggering manually without a git tag',
    '        required: false',
    '      skip-npm:',
    '        description: Skip npm publish (e.g. already published)',
    '        type: boolean',
    '        default: false',
  ],
  'scorecard.yml': [
    '  schedule:',
    '    - cron: "20 7 * * 2"',
    '  branch_protection_rule:',
    '  workflow_dispatch:',
  ],
};

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: values are expressions from the workflows, not JS templates
/**
 * Each if: line as written, indentation kept: four spaces gate a job, eight a step. Every gate is
 * a job gate. A step-level if: would skip a publish or a check on one trigger while the job still
 * reports success to the jobs after it, and an if: always() would run a step after an earlier one
 * failed, so a new one fails until it is listed here.
 */
const IFS: Record<string, string[]> = {
  'ci.yml': [
    "    if: ${{ github.event_name == 'pull_request' || inputs.include-unit }}",
    "    if: github.event_name == 'pull_request'",
  ],
  'codeql.yml': [],
  'docker-sha.yml': [],
  'release.yml': [
    "    if: ${{ github.event_name != 'workflow_dispatch' || !inputs.skip-npm }}",
    "    if: always() && (needs.npm.result == 'success' || needs.npm.result == 'skipped')",
    "    if: always() && (needs.npm.result == 'success' || needs.npm.result == 'skipped') && needs.mcp.result == 'success'",
    "    if: always() && (needs.npm.result == 'success' || needs.npm.result == 'skipped')",
  ],
  'scorecard.yml': [],
};

/**
 * Concurrency by workflow and by job, parsed. cancel-in-progress cancels the older run of a group:
 * on release.yml it would stop a release between the npm and MCP Registry publishes, so release
 * sets none; CodeQL and Scorecard set none today. A ci.yml group shared across refs would cancel
 * another pull request's checks.
 */
const CONCURRENCY: Record<string, Record<string, unknown>> = {
  'ci.yml': {
    workflow: { group: '${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true },
  },
  'codeql.yml': {},
  'docker-sha.yml': {
    workflow: { group: 'docker-sha-${{ github.sha }}', 'cancel-in-progress': true },
  },
  'release.yml': {},
  'scorecard.yml': {},
};
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of workflow values

function concurrency(yaml: string): Record<string, unknown> {
  const { concurrency: workflow, jobs } = parse(yaml) as {
    concurrency?: unknown;
    jobs: Record<string, { concurrency?: unknown }>;
  };
  const byJob = Object.entries(jobs).map(([job, { concurrency: value }]) => [job, value]);
  return Object.fromEntries(
    [['workflow', workflow], ...byJob].filter(([, value]) => value !== undefined),
  );
}

describe('workflow rosters', () => {
  // Each roster is keyed by the files in the tree, so a new workflow fails until it is listed.
  it.each(workflows)('should trigger %s exactly as its pinned on: block says', (name, yaml) => {
    expect(releaseSteps(onBlock(yaml)).trimEnd()).toBe(ON[name]?.join('\n'));
  });

  it.each(workflows)(
    'should gate the jobs and steps of %s only with its pinned if: lines',
    (name, yaml) => {
      expect(readKeyLines(yaml, 'if').map((line) => line.trimEnd())).toEqual(IFS[name]);
    },
  );

  it.each(workflows)('should group runs of %s only by its pinned concurrency', (name, yaml) => {
    expect(concurrency(yaml)).toEqual(CONCURRENCY[name]);
  });

  it.each(workflows)('should keep continue-on-error off every job and step of %s', (_, yaml) => {
    // needs.<job>.result reads success after a failure that continue-on-error let through, so the
    // release gates would publish past a failed npm or MCP publish, a step past a refused stamp
    // would publish server.json unstamped, and a pull request check would pass with failing tests.
    expect(readKeyLines(yaml, 'continue-on-error')).toEqual([]);
  });

  it.each(workflows)('should set no shell and no run defaults in %s', (_, yaml) => {
    // The harnesses run each step as the runner runs one without them: bash -e in the checkout.
    expect(readKeyLines(yaml, 'shell|defaults')).toEqual([]);
  });
});
