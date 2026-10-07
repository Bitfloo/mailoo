import { readdirSync, readFileSync } from 'node:fs';
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

describe('release supply chain', () => {
  it('installs a fixed npm CLI at or above 11.5.1', () => {
    const steps = releaseSteps(releaseYml);
    expect(steps).not.toContain('npm@latest');
    const pinned = steps.match(/npm install -g npm@(\d+)\.(\d+)\.(\d+)/);
    expect(pinned).not.toBeNull();
    if (!pinned) {
      return;
    }
    const major = Number(pinned[1]);
    const minor = Number(pinned[2]);
    const patch = Number(pinned[3]);
    const atOrAbove =
      major > 11 || (major === 11 && minor > 5) || (major === 11 && minor === 5 && patch >= 1);
    expect(atOrAbove).toBe(true);
  });

  it('pins the mcp-publisher archive hash in the install step', () => {
    const step = releaseStep(releaseYml, 'Install mcp-publisher');
    expect(step).not.toContain('releases/latest');
    expect(step).toMatch(/\b[0-9a-f]{64}\b/);
    expect(step).toContain('sha256sum -c');
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
  it('runs CodeQL for javascript-typescript on develop pull requests and weekly', () => {
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
    expect(on).not.toMatch(/^\s+push:/m);
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

function goreleaserImage(yaml: string, id: string): string {
  const match = yaml.match(new RegExp(`- id: ${id}\\n[\\s\\S]*?(?=\\n  - id: |\\nrelease:)`));
  if (!match) {
    throw new Error(`missing goreleaser image ${id}`);
  }
  return match[0];
}

function yamlList(section: string, key: string): string[] {
  const match = section.match(new RegExp(`\\n {4}${key}:\\n((?: {6}- .+\\n)+)`));
  if (!match) {
    throw new Error(`missing ${key}`);
  }
  return match[1]
    .trimEnd()
    .split('\n')
    .map((line) => {
      const raw = line.replace(/^\s*- /, '');
      return raw.startsWith('"') ? raw.slice(1, -1) : raw;
    });
}

/** Shell fragment in docker-rebuild.yml for one GoReleaser tag template. sha-* is release-only. */
const RELEASE_TAG_IN_REBUILD: Record<string, string> = {
  '{{ .Version }}': '"${IMAGE}:${V}"',
  '{{ .Version }}-bookworm': '"${IMAGE}:${V}-bookworm"',
  '{{ .Version }}-alpine': '"${IMAGE}:${V}-alpine"',
  '{{ .Major }}.{{ .Minor }}': '"${IMAGE}:${MAJOR}.${MINOR}"',
  '{{ .Major }}.{{ .Minor }}-bookworm': '"${IMAGE}:${MAJOR}.${MINOR}-bookworm"',
  '{{ .Major }}.{{ .Minor }}-alpine': '"${IMAGE}:${MAJOR}.${MINOR}-alpine"',
  '{{ .Major }}': '"${IMAGE}:${MAJOR}"',
  '{{ .Major }}-bookworm': '"${IMAGE}:${MAJOR}-bookworm"',
  '{{ .Major }}-alpine': '"${IMAGE}:${MAJOR}-alpine"',
  bookworm: '"${IMAGE}:bookworm"',
  '{{ if not .Prerelease }}latest{{ end }}': '"${IMAGE}:latest"',
  '{{ if not .Prerelease }}alpine{{ end }}': '"${IMAGE}:alpine"',
};

describe('docker rebuild images', () => {
  it('uses the release tag names and architectures for bookworm and alpine', () => {
    const goreleaser = readFileSync(join(repoRoot, '.goreleaser.yaml'), 'utf8');
    const workflow = readFileSync(join(workflowDir, 'docker-rebuild.yml'), 'utf8');
    const images = ['mailoo-debian', 'mailoo-alpine'].map((id) => goreleaserImage(goreleaser, id));
    for (const image of images) {
      expect(yamlList(image, 'platforms')).toEqual(['linux/amd64', 'linux/arm64']);
      for (const template of yamlList(image, 'tags')) {
        if (template.includes('ShortCommit')) {
          expect(workflow).not.toContain('sha-${{');
          continue;
        }
        const needle = RELEASE_TAG_IN_REBUILD[template];
        expect(needle, template).toBeTruthy();
        expect(workflow).toContain(needle);
      }
    }
    expect(workflow.match(/platforms: linux\/amd64,linux\/arm64/g)).toHaveLength(2);
    expect(workflow).toContain('if [[ "$V" != *-* ]]');
  });

  it('rebuilds bookworm and alpine for the release architectures', () => {
    const yaml = readFileSync(join(workflowDir, 'docker-rebuild.yml'), 'utf8');
    expect(yaml).toContain('file: Dockerfile\n');
    expect(yaml).toContain('file: Dockerfile.alpine\n');
    expect(yaml.match(/platforms: linux\/amd64,linux\/arm64/g)).toHaveLength(2);
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
