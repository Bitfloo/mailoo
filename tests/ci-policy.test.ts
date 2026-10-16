import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';

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

const releaseYml = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');

/** Comment lines are stripped so a workflow comment mentioning a forbidden string does not trip the content assertions. */
function releaseSteps(yaml: string): string {
  return yaml
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/** Isolate one step so a hash elsewhere cannot satisfy the install check. */
function releaseStep(yaml: string, name: string): string {
  const steps = releaseSteps(yaml);
  const marker = `- name: ${name}\n`;
  const start = steps.indexOf(marker);
  if (start < 0) {
    throw new Error(`missing step ${name}`);
  }
  const rest = steps.slice(start);
  const next = rest.indexOf('\n      - ', marker.length);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The workflow's grep -F operand is the only copy of the npm retry sentence. */
function npmRetryMarker(step: string): string {
  const match = step.match(/grep -F -q "([^"]+)"/);
  if (!match?.[1]) {
    throw new Error('Publish to MCP Registry has no npm retry marker');
  }
  return match[1];
}

/** The step's `run: |` block, dedented, as the runner would execute it. */
function runBlock(step: string): string {
  const match = step.match(/\n {8}run: \|\n((?: {10}.*(?:\n|$))+)/);
  if (!match) {
    throw new Error('step has no run block');
  }
  return match[1].replace(/^ {10}/gm, '');
}

/** Run the release-notes step against the real CHANGELOG.md and return what it wrote. */
function releaseNotes(env: { GITHUB_REF: string; INPUT_VERSION?: string }): string {
  const script = runBlock(releaseStep(releaseYml, 'Write release notes'));
  const temp = mkdtempSync(join(tmpdir(), 'mailoo-release-notes-'));
  try {
    execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, RUNNER_TEMP: temp, ...env },
    });
    return readFileSync(join(temp, 'release-notes.md'), 'utf8');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Body of one release in CHANGELOG.md: the lines between its heading and the next separator. */
function changelogSection(tag: string): string {
  const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const heading = changelog.indexOf(`\n## [${tag}](`);
  if (heading < 0) {
    throw new Error(`CHANGELOG.md has no ${tag} section`);
  }
  const start = changelog.indexOf('\n', heading + 1) + 1;
  return changelog.slice(start, changelog.indexOf('\n- - -', start)).trim();
}

function notesBeforeInstall(notes: string): string {
  return notes.slice(0, notes.indexOf('\n**Install:**')).trim();
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

  it('prepares the packageManager pnpm in the alpine image and the Cursor install', () => {
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      packageManager: string;
    };
    const pins = ['Dockerfile.alpine', '.cursor/environment.json'].map((file) => [
      file,
      readFileSync(join(repoRoot, file), 'utf8').match(/corepack prepare (pnpm@\S+)/)?.[1],
    ]);
    expect(pins).toEqual([
      ['Dockerfile.alpine', root.packageManager],
      ['.cursor/environment.json', root.packageManager],
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

  it('uses the CHANGELOG.md section of the pushed tag as the release body', () => {
    const section = changelogSection('v0.2.0');
    expect(section).toMatch(/^#### ✨ Features\n- add export_email tool/);
    expect(notesBeforeInstall(releaseNotes({ GITHUB_REF: 'refs/tags/v0.2.0' }))).toBe(section);
  });

  it('uses the CHANGELOG.md section of the version input on a manual run', () => {
    const notes = releaseNotes({ GITHUB_REF: 'refs/heads/develop', INPUT_VERSION: '0.1.8' });
    expect(notesBeforeInstall(notes)).toBe(changelogSection('v0.1.8'));
  });

  it('ends the release body with install commands for that version', () => {
    const notes = releaseNotes({ GITHUB_REF: 'refs/tags/v0.2.0' });
    expect(notes.trimEnd().split('\n').slice(-3)).toEqual([
      '**Install:** `npx -y @bitfloo/mailoo@0.2.0` · `docker pull ghcr.io/bitfloo/mailoo:0.2.0` (or `0.2.0-alpine`)',
      '',
      'Full history: [CHANGELOG.md](https://github.com/bitfloo/mailoo/blob/v0.2.0/CHANGELOG.md)',
    ]);
  });

  it('hands the written release body to GoReleaser', () => {
    expect(releaseStep(releaseYml, 'Write release notes')).toContain(
      'notes="$RUNNER_TEMP/release-notes.md"',
    );
    expect(releaseStep(releaseYml, 'Run GoReleaser')).toContain(
      'args: release --clean --release-notes=${{ runner.temp }}/release-notes.md',
    );
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

/** One chunk per job so a token can be required on the scorecard job only. */
function jobSections(yaml: string): string[] {
  const parts = yaml.split(/^jobs:\n/m);
  if (parts.length < 2) {
    throw new Error('missing jobs');
  }
  return parts[1].split(/\n(?= {2}[a-zA-Z0-9_-]+:\n)/);
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
