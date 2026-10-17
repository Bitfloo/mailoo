import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';
import { jobSections, releaseStep, releaseSteps, releaseYml } from './workflow-yaml.js';

const ciYml = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
const dockerSha = readFileSync(join(repoRoot, '.github/workflows/docker-sha.yml'), 'utf8');
const lefthook = readFileSync(join(repoRoot, 'lefthook.yml'), 'utf8');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

function onBlock(yaml: string): string {
  const match = yaml.match(/^on:\n([\s\S]*?)\n(?:concurrency|permissions|jobs):/m);
  if (!match) {
    throw new Error('missing on: block');
  }
  return match[1];
}

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

describe('release supply chain', () => {
  it('installs a fixed npm CLI at or above 11.5.1', () => {
    const steps = releaseSteps(releaseYml);
    expect(steps).not.toContain('npm@latest');
    expect(steps).not.toMatch(/npm install -g npm@/);
    expect(steps).toContain('npm ci --ignore-scripts');
    expect(steps).toContain('working-directory: .github/npm-cli');
    expect(steps).toContain('.github/npm-cli/node_modules/.bin/npm publish --access public');
    const cli = JSON.parse(
      readFileSync(join(repoRoot, '.github/npm-cli/package.json'), 'utf8'),
    ) as {
      dependencies: { npm: string };
    };
    const pinned = exactVersion(cli.dependencies.npm);
    expect(pinned).not.toBeNull();
    if (!pinned) {
      return;
    }
    const [major, minor, patch] = pinned;
    const atOrAbove =
      major > 11 || (major === 11 && minor > 5) || (major === 11 && minor === 5 && patch >= 1);
    expect(atOrAbove).toBe(true);
    const shrink = JSON.parse(
      readFileSync(join(repoRoot, '.github/npm-cli/npm-shrinkwrap.json'), 'utf8'),
    ) as { packages: Record<string, { version?: string; integrity?: string }> };
    expect(shrink.packages['node_modules/npm']?.version).toBe(cli.dependencies.npm);
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

const workflowDir = join(repoRoot, '.github/workflows');

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

describe('workflow shell input', () => {
  it('should expand dispatch inputs and event fields only in if: and env: lines', () => {
    // An expression inside run: is pasted into the script before bash parses it,
    // so a crafted value runs as code. An env: value reaches bash as data.
    const files = readdirSync(workflowDir).filter((name) => name.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    const untrusted = /\$\{\{[^}]*\b(?:inputs\.|github\.event\.|github\.head_ref\b)/;
    const allowed = /^\s*(?:if|[A-Z][A-Z0-9_]*):\s/;
    const inline: string[] = [];
    for (const name of files) {
      const lines = readFileSync(join(workflowDir, name), 'utf8').split('\n');
      for (const line of lines) {
        if (untrusted.test(line) && !allowed.test(line)) {
          inline.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(inline).toEqual([]);
  });
});

function workflowName(yaml: string): string {
  const match = yaml.match(/^name:\s*(\S+)\s*$/m);
  if (!match) {
    throw new Error('missing name');
  }
  return match[1];
}

/** Job keys are indented, so a column-0 match stays on the workflow permissions. */
function topLevelPermissions(yaml: string): string {
  const match = yaml.match(/^permissions:[^\n]*(?:\n {2}[^\n]*)*/m);
  if (!match) {
    throw new Error('missing top-level permissions');
  }
  return match[0];
}

function weeklyCron(yaml: string): string[] {
  const match = yaml.match(/cron:\s*"([^"]+)"/);
  if (!match) {
    throw new Error('missing cron');
  }
  return match[1].split(/\s+/);
}

describe('code scanning workflows', () => {
  it('runs CodeQL on develop pull requests, develop pushes, and weekly', () => {
    const path = join(workflowDir, 'codeql.yml');
    const yaml = readFileSync(path, 'utf8');
    expect(workflowName(yaml)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(topLevelPermissions(yaml)).not.toMatch(/write/);
    expect(topLevelPermissions(yaml)).toContain('contents: read');
    const analyzeJobs = jobSections(yaml).filter((job) =>
      job.includes('github/codeql-action/analyze@'),
    );
    expect(analyzeJobs).toHaveLength(1);
    expect(analyzeJobs[0]).toContain('contents: read');
    expect(analyzeJobs[0]).toContain('security-events: write');
    expect(yaml.replace(analyzeJobs[0], '')).not.toContain('security-events: write');
    const on = onBlock(yaml);
    expect(on).toContain('pull_request:');
    expect(on).toContain('develop');
    expect(on).toContain('schedule:');
    expect(on).toContain('workflow_dispatch:');
    expect(on).toMatch(/push:\n\s+branches:\s*\[develop\]/);
    const cron = weeklyCron(yaml);
    expect(cron).toHaveLength(5);
    expect(cron[2]).toBe('*');
    expect(cron[3]).toBe('*');
    expect(cron[4]).toMatch(/^[0-6]$/);
    expect(yaml).toContain('languages: javascript-typescript');
    expect(yaml).toContain('github/codeql-action/init@');
    expect(yaml).toContain('github/codeql-action/analyze@');
  });

  it('runs OpenSSF Scorecard weekly and when branch protection changes', () => {
    const path = join(workflowDir, 'scorecard.yml');
    const yaml = readFileSync(path, 'utf8');
    expect(workflowName(yaml)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(topLevelPermissions(yaml)).not.toMatch(/write/);
    const jobs = jobSections(yaml);
    const scorecardJobs = jobs.filter((job) => job.includes('ossf/scorecard-action@'));
    expect(scorecardJobs).toHaveLength(1);
    expect(scorecardJobs[0]).toContain('id-token: write');
    expect(scorecardJobs[0]).toContain('security-events: write');
    expect(scorecardJobs[0]).toContain('actions: read');
    expect(scorecardJobs[0]).not.toContain('contents: write');
    expect(scorecardJobs[0]).not.toContain('packages: write');
    expect(yaml.replace(scorecardJobs[0], '')).not.toContain('id-token: write');
    const on = onBlock(yaml);
    expect(on).toContain('schedule:');
    expect(on).toContain('branch_protection_rule:');
    expect(on).not.toMatch(/^\s+push:/m);
    const cron = weeklyCron(yaml);
    expect(cron).toHaveLength(5);
    expect(cron[2]).toBe('*');
    expect(cron[3]).toBe('*');
    expect(cron[4]).toMatch(/^[0-6]$/);
    expect(yaml).toContain('ossf/scorecard-action@');
  });
});

describe('workflow token is no wider than the job writes', () => {
  it('gives CodeQL security-events write and no other write scope', () => {
    const yaml = readFileSync(join(workflowDir, 'codeql.yml'), 'utf8');
    const analyze = jobSections(yaml).find((job) => job.includes('github/codeql-action/analyze@'));
    expect(analyze).toContain('contents: read');
    expect(analyze).toContain('security-events: write');
    expect(analyze).not.toContain('contents: write');
    expect(analyze).not.toContain('packages: write');
    expect(analyze).not.toContain('id-token:');
  });

  it('lets GHCR push jobs write packages and not repository contents', () => {
    for (const name of ['docker-sha.yml', 'docker-rebuild.yml']) {
      const yaml = readFileSync(join(workflowDir, name), 'utf8');
      expect(topLevelPermissions(yaml)).not.toMatch(/write/);
      const pushJobs = jobSections(yaml).filter((job) => job.includes('push: true'));
      expect(pushJobs.length).toBeGreaterThan(0);
      for (const job of pushJobs) {
        expect(job).toContain('packages: write');
        expect(job).toContain('contents: read');
        expect(job).not.toContain('contents: write');
        expect(job).not.toContain('security-events:');
        expect(job).not.toContain('id-token:');
      }
    }
  });

  it('keeps contents write on the GoReleaser job and id-token on the publish jobs', () => {
    const jobs = jobSections(releaseYml);
    const npm = jobs.find((job) => job.includes('npm publish'));
    const mcp = jobs.find((job) => job.includes('mcp-publisher publish'));
    const docker = jobs.find((job) => job.includes('goreleaser/goreleaser-action@'));
    expect(npm).toContain('id-token: write');
    expect(npm).toContain('contents: read');
    expect(npm).not.toContain('contents: write');
    expect(npm).not.toContain('packages: write');
    expect(mcp).toContain('id-token: write');
    expect(mcp).not.toContain('contents: write');
    expect(mcp).not.toContain('packages: write');
    expect(docker).toContain('contents: write');
    expect(docker).toContain('packages: write');
    expect(docker).not.toContain('id-token:');
    expect(docker).not.toContain('security-events:');
  });

  it('does not grant ci.yml any write scope', () => {
    expect(ciYml).not.toMatch(/:\s*write\b/);
    expect(topLevelPermissions(ciYml)).toContain('contents: read');
  });
});

describe('workflow token scope', () => {
  it('does not grant write at the workflow level', () => {
    const files = readdirSync(workflowDir).filter((name) => name.endsWith('.yml'));
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const yaml = readFileSync(join(workflowDir, name), 'utf8');
      expect(topLevelPermissions(yaml), name).not.toMatch(/\bwrite\b/);
    }
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

describe('dependabot groups', () => {
  const config = readFileSync(join(repoRoot, '.github/dependabot.yml'), 'utf8');
  /** Each group's name and settings, read as text: the repo has no YAML parser, so lists stay inline and double-quoted. */
  const groups = [...config.matchAll(/^ {6}([\w-]+):\n((?: {8}.*\n)+)/gm)].map(
    (match) => [match[1], match[2]] as const,
  );

  function group(name: string): string {
    const found = groups.find(([key]) => key === name);
    if (!found) {
      throw new Error(`missing group ${name}`);
    }
    return found[1];
  }

  it('keeps every dependency still on 0.x out of its update group', () => {
    // Dependabot calls 0.25 → 0.27 a minor update, but on 0.x that can break the API (node-ical 0.27 did).
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as Record<
      'dependencies' | 'devDependencies',
      Record<string, string>
    >;
    const onZero = (deps: Record<string, string>) =>
      Object.keys(deps)
        .filter((name) => /^[\^~]?0\./.test(deps[name]))
        .sort();
    const excluded = (name: string) => {
      const list = group(name).match(/^ {8}exclude-patterns: \[(.*)\]$/m)?.[1] ?? '';
      return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
    };
    expect({
      production: excluded('production-dependencies'),
      development: excluded('dev-dependencies'),
    }).toEqual({
      production: onZero(manifest.dependencies),
      development: onZero(manifest.devDependencies),
    });
  });

  it('groups only minor and patch updates', () => {
    // A major can break the API, so it gets its own pull request instead of holding back a group.
    expect(groups.length).toBeGreaterThan(0);
    expect(
      groups.map(([name, block]) => [name, block.match(/^ {8}update-types: (.*)$/m)?.[1]]),
    ).toEqual(groups.map(([name]) => [name, '[minor, patch]']));
  });
});
