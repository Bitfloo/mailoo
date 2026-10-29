import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';
import { mcpHarness } from './mcp-harness.js';
import { notesHarness } from './release-notes-harness.js';
import { jobSteps, resolvedSteps, workflowTexts } from './workflow-yaml.js';

const HARNESSES = [mcpHarness, notesHarness];
const testsDir = join(repoRoot, 'tests');

const { engines } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  engines: { node: string };
};
// CLAUDE.md keeps Node 24 as the floor, so CI on another major tests a runtime nobody is promised.
const node = engines.node.match(/^>=(\d+)\.0\.0$/)?.[1];

/** A step a harness module runs, so its text is checked by running it, not by this roster. */
function harnessed(workflow: string, job: string, label: string | undefined): boolean {
  return HARNESSES.some(
    (harness) =>
      harness.workflow === workflow && harness.job === job && harness.steps.includes(label ?? ''),
  );
}

/**
 * Each job's steps in order: an action without its @ref and with its inputs, keys sorted; a run
 * command with its working directory; or the name of a step a harness module runs.
 */
function steps(workflow: string, yaml: string): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(jobSteps(yaml)).map(([job, list]) => [
      job,
      list.map((step) => {
        if (step.uses) {
          const inputs = Object.entries(step.with ?? {}).sort(([a], [b]) => a.localeCompare(b));
          const shown = inputs.length > 0 ? ` ${JSON.stringify(Object.fromEntries(inputs))}` : '';
          return `${step.uses.split('@')[0]}${shown}`;
        }
        const label = step.name;
        if (harnessed(workflow, job, label)) {
          return `run: ${label} (run by a harness)`;
        }
        const directory = step['working-directory'];
        return `run: ${step.run}${directory ? ` (in ${directory})` : ''}`;
      }),
    ]),
  );
}

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: values are commands and expressions from the workflows, not JS templates
/**
 * Every step of every job, in order. A command moved before the checkout or setup-node would run
 * without them, and an action dropped, added or moved fails too. A checkout ref, repository, path
 * or sparse-checkout would check, build or publish another tree than the commit that started the
 * run; fetch-depth 0 gives GoReleaser and the public-log range the history they read; Scorecard's
 * checkout leaves no token in .git/config for the analysis after it. A registry-url, registry,
 * push, tags or publish_results decides where a publish goes.
 */
const STEPS: Record<string, Record<string, string[]>> = {
  // check and integration run the commands CONTRIBUTING says a pull request runs.
  'ci.yml': {
    check: [
      'actions/checkout',
      'pnpm/action-setup',
      `actions/setup-node {"cache":"pnpm","node-version":"${node}"}`,
      'run: pnpm install --frozen-lockfile',
      'run: pnpm check',
      'run: pnpm typecheck',
      'run: pnpm test',
    ],
    docker: [
      'actions/checkout',
      'docker/setup-buildx-action',
      'docker/build-push-action {"context":".","push":false,"tags":"ghcr.io/bitfloo/mailoo:ci"}',
    ],
    integration: [
      'actions/checkout',
      'pnpm/action-setup',
      `actions/setup-node {"cache":"pnpm","node-version":"${node}"}`,
      'run: pnpm install --frozen-lockfile',
      'run: pnpm test:integration',
    ],
    'public-log': [
      'actions/checkout {"fetch-depth":0}',
      'run: bash scripts/check-public-git-log.sh --range "origin/${BASE_REF}..${HEAD_SHA}"',
      `run: printf '%s\\n\\n%s\\n' "$PR_TITLE" "$PR_BODY" > "$RUNNER_TEMP/pr-text"\nbash scripts/check-public-git-log.sh --file "$RUNNER_TEMP/pr-text"\n`,
    ],
  },
  'codeql.yml': {
    analyze: [
      'actions/checkout',
      'github/codeql-action/init {"build-mode":"none","languages":"javascript-typescript"}',
      'github/codeql-action/analyze',
    ],
  },
  'docker-sha.yml': {
    'sha-images': [
      'actions/checkout',
      'docker/setup-buildx-action',
      'docker/login-action {"password":"${{ secrets.GITHUB_TOKEN }}","registry":"ghcr.io","username":"${{ github.actor }}"}',
      'docker/build-push-action {"context":".","push":true,"tags":"ghcr.io/bitfloo/mailoo:sha-${{ github.sha }}"}',
    ],
  },
  'release.yml': {
    // A flag such as --dry-run, or npm ci run outside .github/npm-cli, would publish nothing.
    npm: [
      'actions/checkout',
      'pnpm/action-setup',
      `actions/setup-node {"cache":"pnpm","node-version":"${node}","registry-url":"https://registry.npmjs.org"}`,
      'run: pnpm install --frozen-lockfile',
      'run: pnpm build',
      'run: npm ci --ignore-scripts (in .github/npm-cli)',
      'run: .github/npm-cli/node_modules/.bin/npm publish --access public',
    ],
    // Stamped after the publish, the registry would get server.json as committed.
    mcp: [
      'actions/checkout',
      'run: Install mcp-publisher (run by a harness)',
      'run: Set version in server.json (run by a harness)',
      'run: ./mcp-publisher login github-oidc',
      'run: Publish to MCP Registry (run by a harness)',
    ],
    // Another checkout or run step before the notes could hand them another CHANGELOG.md or none,
    // and a step between the notes and GoReleaser could rewrite the release body it publishes.
    docker: [
      'actions/checkout {"fetch-depth":0}',
      'docker/setup-qemu-action',
      'docker/setup-buildx-action',
      'docker/login-action {"password":"${{ secrets.GITHUB_TOKEN }}","registry":"ghcr.io","username":"${{ github.actor }}"}',
      'run: Write release notes (run by a harness)',
      'goreleaser/goreleaser-action {"args":"release --clean --release-notes=${{ runner.temp }}/release-notes.md","version":"~> v2"}',
    ],
    // Nothing waits for it, so the aliases cannot hold back the MCP Registry or the images. The
    // script runs on the same hash-pinned npm as the npm job.
    aliases: [
      'actions/checkout',
      `actions/setup-node {"node-version":"${node}","registry-url":"https://registry.npmjs.org"}`,
      'run: npm ci --ignore-scripts (in .github/npm-cli)',
      'run: PATH="$PWD/.github/npm-cli/node_modules/.bin:$PATH" bash scripts/publish-npm-aliases.sh',
    ],
  },
  'scorecard.yml': {
    analysis: [
      'actions/checkout {"persist-credentials":false}',
      'ossf/scorecard-action {"publish_results":true,"results_file":"results.sarif","results_format":"sarif"}',
      'actions/upload-artifact {"name":"sarif-results","path":"results.sarif","retention-days":5}',
      'github/codeql-action/upload-sarif {"sarif_file":"results.sarif"}',
    ],
  },
};
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of workflow values

/** Each function a harness module exports, as `module.name`. */
function runners(): string[] {
  return readdirSync(testsDir)
    .filter((file) => file.endsWith('-harness.ts'))
    .flatMap((file) =>
      Array.from(
        readFileSync(join(testsDir, file), 'utf8').matchAll(/^export function (\w+)/gm),
        ([, name]) => `${file.replace(/\.ts$/, '')}.${name}`,
      ),
    )
    .sort();
}

/** Each name a test file imports from a harness module, as `module.name`. */
function imported(): Set<string> {
  return new Set(
    readdirSync(testsDir)
      .filter((file) => file.endsWith('.test.ts'))
      .flatMap((file) =>
        Array.from(
          readFileSync(join(testsDir, file), 'utf8').matchAll(
            /^import \{([^}]*)\} from '\.\/([\w-]+-harness)\.js';$/gm,
          ),
          ([, names, module]) =>
            names
              .split(',')
              .map((name) => name.trim().replace(/^type /, ''))
              .filter(Boolean)
              .map((name) => `${module}.${name}`),
        ).flat(),
      ),
  );
}

describe('workflow steps', () => {
  // Keyed by the files in the tree, so a new workflow fails until it is listed.
  it.each(workflowTexts())('should run exactly the pinned steps of %s in order', (name, yaml) => {
    expect(steps(name, yaml)).toEqual(STEPS[name]);
  });

  it.each(workflowTexts())('should give no run step of %s a with: input', (_, yaml) => {
    // with: passes inputs to an action, and the roster above shows none on a run step.
    const withRun = Object.values(jobSteps(yaml))
      .flat()
      .filter((step) => step.run !== undefined && step.with !== undefined)
      .map((step) => step.name ?? step.run);
    expect(withRun).toEqual([]);
  });

  it.each([
    { where: 'its own job', workflow: 'release.yml', job: 'mcp', exempt: true },
    { where: 'another job', workflow: 'release.yml', job: 'npm', exempt: false },
    { where: 'another workflow', workflow: 'ci.yml', job: 'mcp', exempt: false },
  ])(
    'should leave a harness step out of the roster only in $where',
    ({ workflow, job, exempt }) => {
      expect(harnessed(workflow, job, 'Publish to MCP Registry')).toBe(exempt);
    },
  );
});

describe('step harnesses', () => {
  // The roster above leaves a declared step out, so a step no runner looks up, or a runner no test
  // file imports, would leave that step checked by nothing.
  it.each(HARNESSES.map((harness) => [`${harness.workflow} ${harness.job}`, harness] as const))(
    'should look up every step the %s harness declares',
    (_, harness) => {
      expect(resolvedSteps(harness)).toEqual([...harness.steps].sort());
    },
  );

  it('should find each runner the harness modules export', () => {
    expect(runners()).toEqual([
      'mcp-harness.install',
      'mcp-harness.publish',
      'mcp-harness.stamp',
      'release-notes-harness.releaseNotes',
    ]);
  });

  it('should have every harness runner imported by a test file', () => {
    const tested = imported();
    expect(runners().filter((runner) => !tested.has(runner))).toEqual([]);
  });
});
