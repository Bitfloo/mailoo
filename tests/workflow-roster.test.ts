import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';
import {
  jobSteps,
  onBlock,
  readKeyLines,
  releaseSteps,
  workflowDir,
  workflowFiles,
} from './workflow-yaml.js';

const { engines } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  engines: { node: string };
};

const workflows = workflowFiles().map(
  (name) => [name, readFileSync(join(workflowDir, name), 'utf8')] as const,
);

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
  'docker-rebuild.yml': ['  schedule:', '    - cron: "0 6 * * 1"', '  workflow_dispatch:'],
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
  'scorecard.yml': ['  schedule:', '    - cron: "20 7 * * 2"', '  branch_protection_rule:'],
};

/** Steps whose run block a harness executes, so their text is checked by running it. */
const HARNESSED = new Set([
  'Install mcp-publisher',
  'Set version in server.json',
  'Publish to MCP Registry',
  'Write release notes',
  'meta',
]);

/** Each run step in file order as `job: command (in directory)`, or by name when a harness runs it. */
function runs(yaml: string): string[] {
  return Object.entries(jobSteps(yaml)).flatMap(([job, steps]) =>
    steps.flatMap((step) => {
      if (step.run === undefined) {
        return [];
      }
      const label = step.name ?? step.id;
      if (label && HARNESSED.has(label)) {
        return [`${job}: ${label} (run by a harness)`];
      }
      const directory = step['working-directory'];
      return [`${job}: ${step.run}${directory ? ` (in ${directory})` : ''}`];
    }),
  );
}

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: values are shell commands from the workflows, not JS templates
const RUNS: Record<string, string[]> = {
  // check and integration run the commands CONTRIBUTING says a pull request runs.
  'ci.yml': [
    'check: pnpm install --frozen-lockfile',
    'check: pnpm check',
    'check: pnpm typecheck',
    'check: pnpm test',
    'integration: pnpm install --frozen-lockfile',
    'integration: pnpm test:integration',
    'public-log: bash scripts/check-public-git-log.sh --range "origin/${BASE_REF}..${HEAD_SHA}"',
    `public-log: printf '%s\\n\\n%s\\n' "$PR_TITLE" "$PR_BODY" > "$RUNNER_TEMP/pr-text"\nbash scripts/check-public-git-log.sh --file "$RUNNER_TEMP/pr-text"\n`,
  ],
  'codeql.yml': [],
  'docker-rebuild.yml': ['rebuild: meta (run by a harness)'],
  'docker-sha.yml': [],
  // A flag such as --dry-run, or the npm CLI directory on another step, publishes nothing.
  'release.yml': [
    'npm: pnpm install --frozen-lockfile',
    'npm: pnpm build',
    'npm: npm ci --ignore-scripts (in .github/npm-cli)',
    'npm: .github/npm-cli/node_modules/.bin/npm publish --access public',
    'mcp: Install mcp-publisher (run by a harness)',
    'mcp: Set version in server.json (run by a harness)',
    'mcp: ./mcp-publisher login github-oidc',
    'mcp: Publish to MCP Registry (run by a harness)',
    'docker: Write release notes (run by a harness)',
  ],
  'scorecard.yml': [],
};
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of shell commands

describe('workflow rosters', () => {
  // Each roster is keyed by the files in the tree, so a new workflow fails until it is listed.
  it.each(workflows)('should trigger %s exactly as its pinned on: block says', (name, yaml) => {
    expect(releaseSteps(onBlock(yaml)).trimEnd()).toBe(ON[name]?.join('\n'));
  });

  it.each(workflows)('should run exactly the pinned commands in %s', (name, yaml) => {
    expect(runs(yaml)).toEqual(RUNS[name]);
  });

  it.each(workflows)('should keep continue-on-error off every job and step of %s', (_, yaml) => {
    // needs.<job>.result reads success after a failure that continue-on-error let through, so the
    // release gates would publish past a failed npm or MCP publish, a step past a refused stamp
    // would publish server.json unstamped, and a pull request check would pass with failing tests.
    expect(readKeyLines(yaml, 'continue-on-error')).toEqual([]);
  });

  it('should set up Node at the package.json engines floor in every setup-node step', () => {
    // CLAUDE.md keeps Node 24 as the floor, so CI on another major tests a runtime nobody is promised.
    const versions = workflows.flatMap(([, yaml]) =>
      Object.values(jobSteps(yaml))
        .flat()
        .filter((step) => step.uses?.startsWith('actions/setup-node@'))
        .map((step) => step.with?.['node-version']),
    );
    expect([...new Set(versions)]).toEqual([engines.node.match(/^>=(\d+)\.0\.0$/)?.[1]]);
  });

  it.each(workflows)('should set no shell and no run defaults in %s', (_, yaml) => {
    // The harnesses run each step as the runner runs one without them: bash -e in the checkout.
    expect(readKeyLines(yaml, 'shell|defaults')).toEqual([]);
  });
});
