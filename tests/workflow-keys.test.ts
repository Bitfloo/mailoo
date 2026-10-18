import { parse } from 'yaml';

import { jobSteps, workflowTexts } from './workflow-yaml.js';

interface Job {
  name?: string;
  'runs-on'?: string;
  needs?: string[];
  env?: Record<string, unknown>;
  steps?: Record<string, unknown>[];
}

interface Workflow {
  name?: string;
  env?: Record<string, unknown>;
  jobs: Record<string, Job>;
}

const workflows = workflowTexts().map(
  ([name, yaml]) => [name, yaml, parse(yaml) as Workflow] as const,
);

/**
 * The keys the workflows set at each level. Every one is read by a roster here, in
 * workflow-roster.test.ts or in workflow-security.test.ts, and step name and id are the labels
 * the step harnesses find a step by. A key outside this list (timeout-minutes, environment,
 * services, container, strategy, secrets, defaults, shell) is read by no test, so it fails here
 * until a roster reads it.
 */
const KEYS = {
  workflow: ['concurrency', 'jobs', 'name', 'on', 'permissions'],
  job: ['env', 'if', 'name', 'needs', 'permissions', 'runs-on', 'steps'],
  step: ['env', 'id', 'name', 'run', 'uses', 'with', 'working-directory'],
};

/**
 * Each workflow's name, then each job's name, runner and needs. A required status check matches a
 * job by its name, the run steps are written for the ubuntu-latest runner's bash and tools, and
 * needs is what orders the npm, MCP Registry and Docker publishes.
 */
const JOBS: Record<string, string[]> = {
  'ci.yml': [
    'ci',
    'check: {"name":"Check, typecheck, test","runs-on":"ubuntu-latest"}',
    'docker: {"name":"Docker build","runs-on":"ubuntu-latest"}',
    'integration: {"name":"Integration tests","runs-on":"ubuntu-latest"}',
    'public-log: {"name":"Public commit and pull request text","runs-on":"ubuntu-latest"}',
  ],
  'codeql.yml': ['codeql', 'analyze: {"name":"Analyze","runs-on":"ubuntu-latest"}'],
  'docker-rebuild.yml': [
    'docker-rebuild',
    'rebuild: {"name":"Rebuild GHCR image","runs-on":"ubuntu-latest"}',
  ],
  'docker-sha.yml': [
    'docker-sha',
    'sha-images: {"name":"Push SHA-tagged image","runs-on":"ubuntu-latest"}',
  ],
  'release.yml': [
    'release',
    'npm: {"name":"Publish to npm","runs-on":"ubuntu-latest"}',
    'mcp: {"name":"Publish to MCP Registry","runs-on":"ubuntu-latest","needs":["npm"]}',
    'docker: {"name":"Publish Docker images","runs-on":"ubuntu-latest","needs":["npm","mcp"]}',
  ],
  'scorecard.yml': [
    'scorecard',
    'analysis: {"name":"Scorecard analysis","runs-on":"ubuntu-latest"}',
  ],
};

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: values are workflow expressions, not JS templates
/**
 * Each action step by job, in order, with its inputs. A checkout ref, repository, path or
 * sparse-checkout would check, build or publish another tree than the commit that started the run,
 * and the release docker job hands GoReleaser the CHANGELOG.md of its checkout. fetch-depth 0 gives
 * GoReleaser and the public-log range the history they read, and Scorecard's checkout leaves no
 * token in .git/config for the analysis after it. A registry-url, registry, push, tags or
 * publish_results decides where a publish goes. A new, dropped or reordered action fails too.
 */
const ACTIONS: Record<string, string[]> = {
  'ci.yml': [
    'check: actions/checkout {}',
    'check: pnpm/action-setup {}',
    'check: actions/setup-node {"node-version":"24","cache":"pnpm"}',
    'docker: actions/checkout {}',
    'docker: docker/setup-buildx-action {}',
    'docker: docker/build-push-action {"context":".","push":false,"tags":"ghcr.io/bitfloo/mailoo:ci"}',
    'integration: actions/checkout {}',
    'integration: pnpm/action-setup {}',
    'integration: actions/setup-node {"node-version":"24","cache":"pnpm"}',
    'public-log: actions/checkout {"fetch-depth":0}',
  ],
  'codeql.yml': [
    'analyze: actions/checkout {}',
    'analyze: github/codeql-action/init {"languages":"javascript-typescript","build-mode":"none"}',
    'analyze: github/codeql-action/analyze {}',
  ],
  'docker-rebuild.yml': [
    'rebuild: actions/checkout {}',
    'rebuild: docker/setup-qemu-action {}',
    'rebuild: docker/setup-buildx-action {}',
    'rebuild: docker/login-action {"registry":"ghcr.io","username":"${{ github.actor }}","password":"${{ secrets.GITHUB_TOKEN }}"}',
    'rebuild: docker/build-push-action {"context":".","file":"Dockerfile","push":true,"platforms":"linux/amd64,linux/arm64","tags":"${{ steps.meta.outputs.bookworm_tags }}"}',
    'rebuild: docker/build-push-action {"context":".","file":"Dockerfile.alpine","push":true,"platforms":"linux/amd64,linux/arm64","tags":"${{ steps.meta.outputs.alpine_tags }}"}',
  ],
  'docker-sha.yml': [
    'sha-images: actions/checkout {}',
    'sha-images: docker/setup-buildx-action {}',
    'sha-images: docker/login-action {"registry":"ghcr.io","username":"${{ github.actor }}","password":"${{ secrets.GITHUB_TOKEN }}"}',
    'sha-images: docker/build-push-action {"context":".","push":true,"tags":"ghcr.io/bitfloo/mailoo:sha-${{ github.sha }}"}',
  ],
  'release.yml': [
    'npm: actions/checkout {}',
    'npm: pnpm/action-setup {}',
    'npm: actions/setup-node {"node-version":"24","registry-url":"https://registry.npmjs.org","cache":"pnpm"}',
    'mcp: actions/checkout {}',
    'docker: actions/checkout {"fetch-depth":0}',
    'docker: docker/setup-qemu-action {}',
    'docker: docker/setup-buildx-action {}',
    'docker: docker/login-action {"registry":"ghcr.io","username":"${{ github.actor }}","password":"${{ secrets.GITHUB_TOKEN }}"}',
    'docker: goreleaser/goreleaser-action {"version":"~> v2","args":"release --clean --release-notes=${{ runner.temp }}/release-notes.md"}',
  ],
  'scorecard.yml': [
    'analysis: actions/checkout {"persist-credentials":false}',
    'analysis: ossf/scorecard-action {"results_file":"results.sarif","results_format":"sarif","publish_results":true}',
    'analysis: actions/upload-artifact {"name":"sarif-results","path":"results.sarif","retention-days":5}',
    'analysis: github/codeql-action/upload-sarif {"sarif_file":"results.sarif"}',
  ],
};

/**
 * Each env: block, the workflow's first, then by job, the job's own before its steps', in order. A run step reads these: a
 * secret moved to a repository variable would print in the public run log, and a token or input
 * swapped would publish under another identity or version.
 */
const ENV: Record<string, string[]> = {
  'ci.yml': [
    'public-log: {"PUBLIC_GIT_EXTRA_FORBIDDEN":"${{ secrets.PUBLIC_GIT_EXTRA_FORBIDDEN }}"}',
    'public-log: {"BASE_REF":"${{ github.base_ref }}","HEAD_SHA":"${{ github.event.pull_request.head.sha }}"}',
    'public-log: {"PR_TITLE":"${{ github.event.pull_request.title }}","PR_BODY":"${{ github.event.pull_request.body }}"}',
  ],
  'codeql.yml': [],
  'docker-rebuild.yml': [],
  'docker-sha.yml': [],
  'release.yml': [
    'mcp: {"INPUT_VERSION":"${{ inputs.version }}"}',
    'docker: {"INPUT_VERSION":"${{ inputs.version }}"}',
    'docker: {"GITHUB_TOKEN":"${{ secrets.GITHUB_TOKEN }}"}',
  ],
  'scorecard.yml': [],
};
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of workflow expressions

describe('workflow keys', () => {
  // Each roster is keyed by the files in the tree, so a new workflow fails until it is listed.
  it('should set only the workflow, job and step keys a roster reads', () => {
    const keysOf = (objects: object[]) => [...new Set(objects.flatMap(Object.keys))].sort();
    const docs = workflows.map(([, , doc]) => doc);
    const jobs = docs.flatMap((doc) => Object.values(doc.jobs));
    const steps = jobs.flatMap((job) => job.steps ?? []);
    expect({ workflow: keysOf(docs), job: keysOf(jobs), step: keysOf(steps) }).toEqual(KEYS);
  });

  it.each(workflows)('should name %s in lowercase kebab-case', (_, __, doc) => {
    // CLAUDE.md asks for a lowercase kebab-case name: on every workflow.
    expect(doc.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it.each(workflows)('should name, place and order the jobs of %s as pinned', (name, _, doc) => {
    const jobs = Object.entries(doc.jobs).map(
      ([id, job]) =>
        `${id}: ${JSON.stringify({ name: job.name, 'runs-on': job['runs-on'], needs: job.needs })}`,
    );
    expect([doc.name, ...jobs]).toEqual(JOBS[name]);
  });

  it.each(workflows)('should hand each action in %s only its pinned inputs', (name, yaml) => {
    const actions = Object.entries(jobSteps(yaml)).flatMap(([job, steps]) =>
      steps.flatMap((step) =>
        step.uses ? [`${job}: ${step.uses.split('@')[0]} ${JSON.stringify(step.with ?? {})}`] : [],
      ),
    );
    expect(actions).toEqual(ACTIONS[name]);
  });

  it.each(workflows)('should set only the pinned env: values in %s', (name, yaml, doc) => {
    const blocks = Object.entries(jobSteps(yaml)).flatMap(([job, steps]) =>
      [doc.jobs[job].env, ...steps.map((step) => step.env)]
        .filter((env) => env !== undefined)
        .map((env) => `${job}: ${JSON.stringify(env)}`),
    );
    const top = doc.env === undefined ? [] : [`workflow: ${JSON.stringify(doc.env)}`];
    expect([...top, ...blocks]).toEqual(ENV[name]);
  });
});
