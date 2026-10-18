import { mcpHarness } from './mcp-harness.js';
import { metaHarness } from './rebuild-harness.js';
import { notesHarness } from './release-notes-harness.js';
import { jobSteps, workflowTexts } from './workflow-yaml.js';

/** A step a harness module runs, so its text is checked by running it, not by this roster. */
function harnessed(workflow: string, job: string, label: string | undefined): boolean {
  return [mcpHarness, notesHarness, metaHarness].some(
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
        const label = step.name ?? step.id;
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
 * Every step of every job, in order. A command moved before the checkout or setup-node runs
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
      'actions/setup-node {"cache":"pnpm","node-version":"24"}',
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
      'actions/setup-node {"cache":"pnpm","node-version":"24"}',
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
  // meta writes the tag lists both builds push.
  'docker-rebuild.yml': {
    rebuild: [
      'actions/checkout',
      'docker/setup-qemu-action',
      'docker/setup-buildx-action',
      'docker/login-action {"password":"${{ secrets.GITHUB_TOKEN }}","registry":"ghcr.io","username":"${{ github.actor }}"}',
      'run: meta (run by a harness)',
      'docker/build-push-action {"context":".","file":"Dockerfile","platforms":"linux/amd64,linux/arm64","push":true,"tags":"${{ steps.meta.outputs.bookworm_tags }}"}',
      'docker/build-push-action {"context":".","file":"Dockerfile.alpine","platforms":"linux/amd64,linux/arm64","push":true,"tags":"${{ steps.meta.outputs.alpine_tags }}"}',
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
    // A flag such as --dry-run, or the npm CLI directory on another step, publishes nothing.
    npm: [
      'actions/checkout',
      'pnpm/action-setup',
      'actions/setup-node {"cache":"pnpm","node-version":"24","registry-url":"https://registry.npmjs.org"}',
      'run: pnpm install --frozen-lockfile',
      'run: pnpm build',
      'run: npm ci --ignore-scripts (in .github/npm-cli)',
      'run: .github/npm-cli/node_modules/.bin/npm publish --access public',
    ],
    // server.json is stamped before the step that publishes it.
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

describe('workflow steps', () => {
  // Keyed by the files in the tree, so a new workflow fails until it is listed.
  it.each(workflowTexts())('should run exactly the pinned steps of %s in order', (name, yaml) => {
    expect(steps(name, yaml)).toEqual(STEPS[name]);
  });
});
