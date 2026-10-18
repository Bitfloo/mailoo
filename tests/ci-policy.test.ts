import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'yaml';

import { repoRoot } from './agents/agent-file.js';
import { unpinnedUses } from './workflow-scan.js';
import {
  jobSections,
  jobSteps,
  onBlock,
  readKeyLines,
  refEnv,
  releaseStep,
  releaseSteps,
  releaseYml,
  runBlock,
  runStep,
  stepEnv,
  triggers,
  workflowDir,
  workflowFiles,
} from './workflow-yaml.js';

const ciYml = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const dockerSha = readFileSync(join(repoRoot, '.github/workflows/docker-sha.yml'), 'utf8');
const lefthook = readFileSync(join(repoRoot, 'lefthook.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
  packageManager: string;
};

describe('CI spend policy', () => {
  it('should keep GitHub ci.yml off push so the laptop script owns unit and lint', () => {
    expect(triggers(ciYml)).toEqual(['  pull_request:', '  workflow_dispatch:']);
  });

  it('should run ci.yml on pull requests to develop', () => {
    expect(onBlock(ciYml)).toMatch(/^ {2}pull_request:\n {4}branches: \[develop\]$/m);
  });

  it('should publish a SHA image only when a maintainer starts it by hand', () => {
    expect(triggers(dockerSha)).toEqual(['  workflow_dispatch:']);
  });

  it('should wire ci-local into the package scripts and pre-push', () => {
    expect(pkg.scripts['ci:local']).toBe('bash scripts/ci-local.sh');
    expect(lefthook).toContain('scripts/ci-local.sh');
  });

  it('should name the dispatch include-unit flag in ci.yml and CLAUDE.md', () => {
    const claude = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
    expect(ciYml).toContain('include-unit');
    expect(claude).toContain('include-unit');
  });

  it('should list exactly the ci.yml jobs in the CONTRIBUTING pull request sentence', () => {
    const contributing = readFileSync(join(repoRoot, 'CONTRIBUTING.md'), 'utf8');
    const sentence = contributing.match(/runs the `ci\.yml` jobs (.+?)\.(?:\s|$)/s)?.[1] ?? '';
    const listed = [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
    const names = jobSections(ciYml)
      .map((job) => job.match(/^ {4}name: (.+)$/m)?.[1])
      .sort();
    expect(listed).toEqual(names);
  });

  it('should run every ci.yml job on a pull request, as the CONTRIBUTING job list says', () => {
    // Each gate below is true on pull_request; a new or changed one fails until it is shown to be.
    const { jobs } = parse(ciYml) as { jobs: Record<string, { if?: string }> };
    const gates = Object.entries(jobs).map(([id, job]) => [id, job.if ?? null]);
    expect(Object.fromEntries(gates)).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub expression, not a JS template
      check: "${{ github.event_name == 'pull_request' || inputs.include-unit }}",
      docker: null,
      integration: null,
      'public-log': "github.event_name == 'pull_request'",
    });
  });

  it('should run the commands CONTRIBUTING names in the ci.yml check and integration jobs', () => {
    const steps = jobSteps(ciYml);
    const runs = (job: string) => steps[job].flatMap((step) => (step.run ? [step.run] : []));
    expect({ check: runs('check'), integration: runs('integration') }).toEqual({
      check: ['pnpm install --frozen-lockfile', 'pnpm check', 'pnpm typecheck', 'pnpm test'],
      integration: ['pnpm install --frozen-lockfile', 'pnpm test:integration'],
    });
  });

  it('should describe CodeQL push and weekly runs only while codeql.yml has those triggers', () => {
    const contributing = readFileSync(join(repoRoot, 'CONTRIBUTING.md'), 'utf8');
    const codeqlOn = onBlock(readFileSync(join(repoRoot, '.github/workflows/codeql.yml'), 'utf8'));
    expect(contributing).toContain('CodeQL also runs on pushes to `develop` and weekly');
    expect(codeqlOn).toMatch(/^ {2}push:\n {4}branches: \[develop\]$/m);
    expect(codeqlOn).toMatch(/^ {2}schedule:$/m);
  });
});

function exactVersion(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const npmCli = JSON.parse(readFileSync(join(repoRoot, '.github/npm-cli/package.json'), 'utf8')) as {
  dependencies: { npm: string };
};
const pnpmCli = JSON.parse(
  readFileSync(join(repoRoot, 'docker/pnpm-cli/package.json'), 'utf8'),
) as {
  dependencies: { pnpm: string };
};
const pnpmShrink = JSON.parse(
  readFileSync(join(repoRoot, 'docker/pnpm-cli/npm-shrinkwrap.json'), 'utf8'),
) as { packages: Record<string, { version?: string; integrity?: string }> };

describe('release supply chain', () => {
  it('should not install the release npm CLI from a moving tag or a global install', () => {
    expect(releaseSteps(releaseYml)).not.toContain('npm@latest');
    expect(releaseSteps(releaseYml)).not.toMatch(/npm install -g npm@/);
  });

  it('should install the release npm CLI with npm ci in .github/npm-cli', () => {
    expect(releaseSteps(releaseYml)).toContain('npm ci --ignore-scripts');
    expect(releaseSteps(releaseYml)).toContain('working-directory: .github/npm-cli');
  });

  it('should publish with the npm CLI installed in .github/npm-cli', () => {
    expect(releaseSteps(releaseYml)).toContain(
      '.github/npm-cli/node_modules/.bin/npm publish --access public',
    );
  });

  it('should pin the release npm CLI to an exact version at or above 11.5.1', () => {
    const pinned = exactVersion(npmCli.dependencies.npm);
    expect(pinned).not.toBeNull();
    if (!pinned) {
      return;
    }
    const [major, minor, patch] = pinned;
    const atOrAbove =
      major > 11 || (major === 11 && minor > 5) || (major === 11 && minor === 5 && patch >= 1);
    expect(atOrAbove).toBe(true);
  });

  it('should lock the pinned npm CLI version with an sha512 hash in its shrinkwrap', () => {
    const shrink = JSON.parse(
      readFileSync(join(repoRoot, '.github/npm-cli/npm-shrinkwrap.json'), 'utf8'),
    ) as { packages: Record<string, { version?: string; integrity?: string }> };
    expect(shrink.packages['node_modules/npm']?.version).toBe(npmCli.dependencies.npm);
    expect(shrink.packages['node_modules/npm']?.integrity).toMatch(/^sha512-/);
  });

  it('should install the image pnpm CLI with npm ci and not a global install', () => {
    const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('npm ci --ignore-scripts');
    expect(dockerfile).not.toContain('npm install -g pnpm@');
  });

  it('should pin the image pnpm CLI to the packageManager version', () => {
    expect(`pnpm@${pnpmCli.dependencies.pnpm}`).toBe(pkg.packageManager);
  });

  it('should lock the image pnpm CLI version with an sha512 hash in its shrinkwrap', () => {
    expect(pnpmShrink.packages['node_modules/pnpm']).toMatchObject({
      version: pnpmCli.dependencies.pnpm,
      integrity: expect.stringMatching(/^sha512-/),
    });
  });

  it('should prepare the packageManager pnpm by its tarball hash in the alpine image and the Cursor install', () => {
    // Corepack checks the download against a +sha512.<hex> suffix. The hash is the
    // shrinkwrap integrity the Debian image installs, so all three move together.
    const integrity = pnpmShrink.packages['node_modules/pnpm']?.integrity ?? '';
    const hex = Buffer.from(integrity.replace(/^sha512-/, ''), 'base64').toString('hex');
    const pins = ['Dockerfile.alpine', '.cursor/environment.json'].map((file) => [
      file,
      readFileSync(join(repoRoot, file), 'utf8').match(/corepack prepare (pnpm@[^\s"]+)/)?.[1],
    ]);
    expect(pins).toEqual([
      ['Dockerfile.alpine', `${pkg.packageManager}+sha512.${hex}`],
      ['.cursor/environment.json', `${pkg.packageManager}+sha512.${hex}`],
    ]);
  });
});

describe('release version selection', () => {
  // The stamp refuses an empty or ref-shaped version, so a tag push breaks unless the step falls back to the tag.
  it.each([
    { event: 'tag push', ref: 'refs/tags/v1.4.2', inputVersion: '', version: '1.4.2' },
    { event: 'manual run', ref: 'refs/heads/develop', inputVersion: '2.0.0', version: '2.0.0' },
  ])('should hand the server.json stamp $version on a $event', ({ ref, inputVersion, version }) => {
    const step = releaseStep(releaseYml, 'Set version in server.json');
    const temp = mkdtempSync(join(tmpdir(), 'mailoo-server-json-step-'));
    try {
      mkdirSync(join(temp, 'scripts'));
      writeFileSync(join(temp, 'scripts/bump-server-json-version.sh'), 'printf "%s\\n" "$1"\n');
      const stamped = runStep(runBlock(step), temp, {
        PATH: process.env.PATH,
        ...refEnv(ref),
        ...stepEnv(step, { 'inputs.version': inputVersion }),
      });
      expect({ status: stamped.status, stdout: stamped.stdout }).toEqual({
        status: 0,
        stdout: `${version}\n`,
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('should refuse a step env value the harness has no context for', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub expression, not a JS template
    const step = '      - run: x\n        env:\n          A: ${{ inputs.other }}\n';
    expect(() => stepEnv(step, {})).toThrow('no value for inputs.other');
  });

  it('should run the server.json stamp step with the shell and directory the harness uses', () => {
    // shell and working-directory would run other code than the harness checks.
    const step = releaseStep(releaseYml, 'Set version in server.json');
    expect(readKeyLines(step, 'shell|working-directory')).toEqual([]);
  });

  it('should stamp server.json before the step that publishes it to the MCP Registry', () => {
    // Both steps are listed in file order, so a missing step fails too, not only a swapped one.
    const order = [
      ...releaseSteps(releaseYml).matchAll(
        /^ {6}- name: (Set version in server\.json|Publish to MCP Registry)$/gm,
      ),
    ].map((match) => match[1]);
    expect(order).toEqual(['Set version in server.json', 'Publish to MCP Registry']);
  });
});

describe('pinned GitHub Actions', () => {
  it('should pin every uses: to a commit SHA with the version tag in a comment', () => {
    const unpinned = workflowFiles().flatMap((name) =>
      unpinnedUses(readFileSync(join(workflowDir, name), 'utf8')).map((line) => `${name}: ${line}`),
    );
    expect(unpinned).toEqual([]);
  });

  const sha = 'd23441a48e516b6c34aea4fa41551a30e30af803';

  it.each([
    '- { uses: actions/checkout@v6 }',
    `- uses: a/b@${sha.slice(0, 7)} # v1.2.3`,
    `- uses: a/b@${sha}`,
    `- uses: a/b@${sha} # main`,
    '- "uses": a/b@v4',
    '- uses: ./local',
    '- uses: docker://alpine:3',
    `- uses: a/b@${sha} # v1`,
    `- uses: a/b@${sha} # v1.2.3 junk`,
    `- uses: a/b@${'g'.repeat(40)} # v1.2.3`,
  ])('should flag %j as a uses: not pinned to a commit SHA and version tag', (line) => {
    expect(unpinnedUses(`    steps:\n      ${line}\n`)).toEqual([line]);
  });

  it('should pass a uses: pinned to a commit SHA with its version tag in a comment', () => {
    expect(unpinnedUses(`    steps:\n      - uses: a/b@${sha} # v1.2.3\n`)).toEqual([]);
  });
});

describe('docker rebuild images', () => {
  it('should set up QEMU so the rebuild can build the arm64 release image', () => {
    const yaml = readFileSync(join(workflowDir, 'docker-rebuild.yml'), 'utf8');
    expect(yaml).toContain('docker/setup-qemu-action@');
  });
});
