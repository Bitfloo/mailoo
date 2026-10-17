import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';
import {
  jobSections,
  onBlock,
  refEnv,
  releaseStep,
  releaseSteps,
  releaseYml,
  stepEnv,
  topLevelPermissions,
  workflowDir,
} from './workflow-yaml.js';

const ciYml = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const dockerSha = readFileSync(join(repoRoot, '.github/workflows/docker-sha.yml'), 'utf8');
const lefthook = readFileSync(join(repoRoot, 'lefthook.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('CI spend policy', () => {
  it('keeps GitHub ci.yml off push so the laptop script owns unit lint', () => {
    const on = onBlock(ciYml);
    expect(on).toContain('pull_request:');
    expect(on).toContain('workflow_dispatch:');
    expect(on).not.toMatch(/^\s+push:/m);
  });

  it('does not publish a SHA image on every main push', () => {
    expect(onBlock(dockerSha)).not.toMatch(/^\s+push:/m);
    expect(onBlock(dockerSha)).toContain('workflow_dispatch:');
  });

  it('wires ci-local into package scripts and pre-push', () => {
    expect(pkg.scripts['ci:local']).toBe('bash scripts/ci-local.sh');
    expect(lefthook).toContain('scripts/ci-local.sh');
  });

  it('names the dispatch include-unit flag in ci.yml and CLAUDE.md', () => {
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

  it('should describe CodeQL push and weekly runs only while codeql.yml has those triggers', () => {
    const contributing = readFileSync(join(repoRoot, 'CONTRIBUTING.md'), 'utf8');
    const codeqlOn = onBlock(readFileSync(join(repoRoot, '.github/workflows/codeql.yml'), 'utf8'));
    expect(contributing).toContain('CodeQL also runs on pushes to `develop` and weekly');
    expect(codeqlOn).toMatch(/^ {2}push:\n {4}branches: \[develop\]$/m);
    expect(codeqlOn).toMatch(/^ {2}schedule:$/m);
  });
});

/** The workflow's grep -F operand is the only copy of the npm retry sentence. */
function npmRetryMarker(step: string): string {
  const match = step.match(/grep -F -q "([^"]+)"/);
  if (!match?.[1]) {
    throw new Error('Publish to MCP Registry has no npm retry marker');
  }
  return match[1];
}

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

  it('installs the image pnpm CLI with npm ci against a shrinkwrap', () => {
    const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('npm ci --ignore-scripts');
    expect(dockerfile).not.toContain('npm install -g pnpm@');
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    const cli = JSON.parse(
      readFileSync(join(repoRoot, 'docker/pnpm-cli/package.json'), 'utf8'),
    ) as {
      dependencies: { pnpm: string };
    };
    expect(`pnpm@${cli.dependencies.pnpm}`).toBe(root.packageManager);
    const shrink = JSON.parse(
      readFileSync(join(repoRoot, 'docker/pnpm-cli/npm-shrinkwrap.json'), 'utf8'),
    ) as { packages: Record<string, { version?: string; integrity?: string }> };
    expect(shrink.packages['node_modules/pnpm']?.version).toBe(cli.dependencies.pnpm);
    expect(shrink.packages['node_modules/pnpm']?.integrity).toMatch(/^sha512-/);
  });

  it('prepares the packageManager pnpm by its tarball hash in the alpine image and the Cursor install', () => {
    // Corepack checks the download against a +sha512.<hex> suffix. The hash is the
    // shrinkwrap integrity the Debian image installs, so all three move together.
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    const shrink = JSON.parse(
      readFileSync(join(repoRoot, 'docker/pnpm-cli/npm-shrinkwrap.json'), 'utf8'),
    ) as { packages: Record<string, { integrity?: string }> };
    const integrity = shrink.packages['node_modules/pnpm']?.integrity ?? '';
    const hex = Buffer.from(integrity.replace(/^sha512-/, ''), 'base64').toString('hex');
    const pins = ['Dockerfile.alpine', '.cursor/environment.json'].map((file) => [
      file,
      readFileSync(join(repoRoot, file), 'utf8').match(/corepack prepare (pnpm@[^\s"]+)/)?.[1],
    ]);
    expect(pins).toEqual([
      ['Dockerfile.alpine', `${root.packageManager}+sha512.${hex}`],
      ['.cursor/environment.json', `${root.packageManager}+sha512.${hex}`],
    ]);
  });

  it('pins the mcp-publisher archive hash in the install step', () => {
    const step = releaseStep(releaseYml, 'Install mcp-publisher');
    expect(step).not.toContain('releases/latest');
    expect(step).toMatch(/\b[0-9a-f]{64}\b/);
    expect(step).toContain('sha256sum -c');
  });

  it('retries MCP publish only while npm has not propagated the version', () => {
    const step = releaseStep(releaseYml, 'Publish to MCP Registry');
    const marker = npmRetryMarker(step);
    const unmatched = step.indexOf('if ! grep -F -q');
    const exitStatus = step.indexOf('exit "$status"', unmatched);
    expect(step).toContain('./mcp-publisher publish');
    expect(step).toContain('attempts=6');
    expect(step).toContain('pause=20');
    expect(step).toContain('for ((attempt = 1; attempt <= attempts; attempt++)); do');
    expect(unmatched).toBeGreaterThan(step.indexOf('./mcp-publisher publish'));
    expect(exitStatus).toBeGreaterThan(unmatched);
    expect(step.indexOf('sleep "$pause"')).toBeGreaterThan(exitStatus);
    expect(step.slice(unmatched, exitStatus)).not.toContain('sleep');
    expect(marker.length).toBeGreaterThan(0);
    const docker = jobSections(releaseYml).find((job) =>
      job.includes('goreleaser/goreleaser-action@'),
    );
    expect(docker).toContain('needs: [npm, mcp]');
    expect(docker).toContain("needs.mcp.result == 'success'");
  });
});

/** The step's one-line `run:` command, as the runner would execute it. */
function runLine(step: string): string {
  const match = step.match(/^ {8}run: (?!\|)(.+)$/m);
  if (!match) {
    throw new Error('step has no one-line run');
  }
  return match[1];
}

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
      // A run step without `shell:` gets `bash -e {0}` on the runner.
      const stamped = execFileSync('bash', ['-e', '-c', runLine(step)], {
        cwd: temp,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          ...refEnv(ref),
          ...stepEnv(step, { 'inputs.version': inputVersion }),
        },
      });
      expect(stamped).toBe(`${version}\n`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('should run the server.json stamp step as the harness runs it on every release event', () => {
    // A tag push and a manual run both publish, so a step-level if: would ship one of them unstamped.
    // continue-on-error publishes past a refused version; shell and working-directory run other code.
    expect(releaseStep(releaseYml, 'Set version in server.json')).not.toMatch(
      /^ {8}(?:if|continue-on-error|shell|working-directory):/m,
    );
  });

  it('should stamp server.json before the step that publishes it to the MCP Registry', () => {
    const steps = releaseSteps(releaseYml);
    expect(steps.indexOf('- name: Set version in server.json\n')).toBeLessThan(
      steps.indexOf('- name: Publish to MCP Registry\n'),
    );
  });
});

describe('pinned GitHub Actions', () => {
  it('pins every uses: to a commit SHA with the version tag in a comment', () => {
    const files = readdirSync(workflowDir).filter((name) => name.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    const pin = /^\s*(?:-\s*)?uses:\s+\S+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/;
    const unpinned: string[] = [];
    for (const name of files) {
      const uses = readFileSync(join(workflowDir, name), 'utf8')
        .split('\n')
        .filter((line) => /^\s*(?:-\s*)?uses:/.test(line));
      for (const line of uses) {
        if (!pin.test(line)) {
          unpinned.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(unpinned).toEqual([]);
  });
});

describe('docker rebuild images', () => {
  it('rebuilds bookworm and alpine for the release architectures', () => {
    const yaml = readFileSync(join(workflowDir, 'docker-rebuild.yml'), 'utf8');
    expect(yaml).toContain('docker/setup-qemu-action@');
    expect(yaml).toContain('-alpine');
    expect(yaml).toContain(':bookworm');
    expect(yaml).toContain(':latest');
    expect(yaml).not.toContain('sha-${{');
    expect(topLevelPermissions(yaml)).not.toMatch(/write/);
    const jobs = jobSections(yaml);
    expect(jobs.some((job) => job.includes('packages: write'))).toBe(true);
  });
});
