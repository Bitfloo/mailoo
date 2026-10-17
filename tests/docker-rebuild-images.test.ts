import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'yaml';

import { repoRoot } from './agents/agent-file.js';
import { workflowDir } from './workflow-yaml.js';

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

function yamlScalar(section: string, key: string): string {
  const match = section.match(new RegExp(`\\n {4}${key}: (\\S+)`));
  if (!match) {
    throw new Error(`missing ${key}`);
  }
  const raw = match[1];
  return raw.startsWith('"') ? raw.slice(1, -1) : raw;
}

/** Shell fragment in docker-rebuild.yml for one GoReleaser tag template. sha-* is release-only. */
// biome-ignore-start lint/suspicious/noTemplateCurlyInString: values are shell fragments from docker-rebuild.yml, not JS templates
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
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of shell fragments

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

const rebuildSteps = (
  parse(readFileSync(join(workflowDir, 'docker-rebuild.yml'), 'utf8')) as {
    jobs: { rebuild: { steps: Step[] } };
  }
).jobs.rebuild.steps;

/** Run the meta step in a checkout whose package.json holds `version`; return what it wrote. */
function metaOutputs(version: string): Record<string, string> {
  const run = rebuildSteps.find((step) => step.id === 'meta')?.run;
  if (!run) {
    throw new Error('missing meta step');
  }
  const temp = mkdtempSync(join(tmpdir(), 'mailoo-docker-rebuild-'));
  try {
    writeFileSync(join(temp, 'package.json'), JSON.stringify({ version }));
    // A run step without `shell:` gets `bash -e {0}` on the runner.
    execFileSync('bash', ['-e', '-c', run], {
      cwd: temp,
      env: { PATH: process.env.PATH, GITHUB_OUTPUT: join(temp, 'output') },
      stdio: 'pipe',
    });
    const lines = readFileSync(join(temp, 'output'), 'utf8').trim().split('\n');
    return Object.fromEntries(
      lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function images(...tags: string[]): string {
  return tags.map((tag) => `ghcr.io/bitfloo/mailoo:${tag}`).join(',');
}

describe('docker rebuild images', () => {
  it('should hand each Dockerfile its own tag list and push it', () => {
    const builds = rebuildSteps
      .filter((step) => step.uses?.startsWith('docker/build-push-action@'))
      .map(({ with: input }) => [
        input?.file,
        String(input?.tags).match(/^\$\{\{ steps\.meta\.outputs\.(\w+) \}\}$/)?.[1],
        input?.push,
      ]);
    expect(builds).toEqual([
      ['Dockerfile', 'bookworm_tags', true],
      ['Dockerfile.alpine', 'alpine_tags', true],
    ]);
  });

  it.each([
    [
      '1.4.2',
      images(
        '1.4.2',
        '1.4.2-bookworm',
        '1.4',
        '1.4-bookworm',
        '1',
        '1-bookworm',
        'bookworm',
        'latest',
      ),
      images('1.4.2-alpine', '1.4-alpine', '1-alpine', 'alpine'),
    ],
    [
      '1.5.0-rc.1',
      images(
        '1.5.0-rc.1',
        '1.5.0-rc.1-bookworm',
        '1.5',
        '1.5-bookworm',
        '1',
        '1-bookworm',
        'bookworm',
      ),
      images('1.5.0-rc.1-alpine', '1.5-alpine', '1-alpine'),
    ],
  ])('should write the release tag names for package version %s', (version, bookworm, alpine) => {
    expect(metaOutputs(version)).toEqual({ bookworm_tags: bookworm, alpine_tags: alpine });
  });

  it('uses the release tag names, Dockerfiles, and architectures', () => {
    const goreleaser = readFileSync(join(repoRoot, '.goreleaser.yaml'), 'utf8');
    const workflow = readFileSync(join(workflowDir, 'docker-rebuild.yml'), 'utf8');
    for (const id of ['mailoo-debian', 'mailoo-alpine']) {
      const image = goreleaserImage(goreleaser, id);
      expect(workflow, id).toContain(`file: ${yamlScalar(image, 'dockerfile')}\n`);
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
  });
});
