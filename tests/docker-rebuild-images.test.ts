import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'yaml';

import { repoRoot } from './agents/agent-file.js';
import { runStep, workflowDir } from './workflow-yaml.js';

interface GoreleaserImage {
  id: string;
  dockerfile: string;
  platforms: string[];
  tags: string[];
}

const goreleaserImages = (
  parse(readFileSync(join(repoRoot, '.goreleaser.yaml'), 'utf8')) as {
    dockers_v2: GoreleaserImage[];
  }
).dockers_v2;

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

/** Run the meta step in a checkout holding `manifest` as package.json; return its status, stderr and outputs. */
function meta(manifest: object) {
  const run = rebuildSteps.find((step) => step.id === 'meta')?.run;
  if (!run) {
    throw new Error('missing meta step');
  }
  const temp = mkdtempSync(join(tmpdir(), 'mailoo-docker-rebuild-'));
  try {
    writeFileSync(join(temp, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(temp, 'output'), '');
    const { status, stderr } = runStep(run, temp, {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: join(temp, 'output'),
    });
    const lines = readFileSync(join(temp, 'output'), 'utf8').split('\n').filter(Boolean);
    const outputs = Object.fromEntries(
      lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return { status, stderr, outputs };
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
    [
      '1.5.0-beta.2',
      images(
        '1.5.0-beta.2',
        '1.5.0-beta.2-bookworm',
        '1.5',
        '1.5-bookworm',
        '1',
        '1-bookworm',
        'bookworm',
      ),
      images('1.5.0-beta.2-alpine', '1.5-alpine', '1-alpine'),
    ],
    [
      '1.10.12',
      images(
        '1.10.12',
        '1.10.12-bookworm',
        '1.10',
        '1.10-bookworm',
        '1',
        '1-bookworm',
        'bookworm',
        'latest',
      ),
      images('1.10.12-alpine', '1.10-alpine', '1-alpine', 'alpine'),
    ],
    [
      '10.2.0',
      images(
        '10.2.0',
        '10.2.0-bookworm',
        '10.2',
        '10.2-bookworm',
        '10',
        '10-bookworm',
        'bookworm',
        'latest',
      ),
      images('10.2.0-alpine', '10.2-alpine', '10-alpine', 'alpine'),
    ],
  ])('should write the release tag names for package version %s', (version, bookworm, alpine) => {
    expect(meta({ version })).toEqual({
      status: 0,
      stderr: '',
      outputs: { bookworm_tags: bookworm, alpine_tags: alpine },
    });
  });

  it.each([{}, { version: '' }])('should refuse to tag a package.json holding %j', (manifest) => {
    expect(meta(manifest)).toEqual({
      status: 1,
      stderr: 'package.json version is empty\n',
      outputs: {},
    });
  });

  it('should use the GoReleaser tag names, Dockerfiles and architectures', () => {
    const workflow = readFileSync(join(workflowDir, 'docker-rebuild.yml'), 'utf8');
    for (const id of ['mailoo-debian', 'mailoo-alpine']) {
      const image = goreleaserImages.find((entry) => entry.id === id);
      if (!image) {
        throw new Error(`missing goreleaser image ${id}`);
      }
      expect(workflow, id).toContain(`file: ${image.dockerfile}\n`);
      expect(image.platforms).toEqual(['linux/amd64', 'linux/arm64']);
      for (const template of image.tags) {
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
