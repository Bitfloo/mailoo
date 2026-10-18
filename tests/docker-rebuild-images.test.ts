import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { repoRoot } from './agents/agent-file.js';
import { meta, rebuildYml } from './rebuild-harness.js';
import { jobSteps, requireTools, workflowDir } from './workflow-yaml.js';

requireTools(['bash', 'jq']);

interface GoreleaserImage {
  id: string;
  dockerfile: string;
  images: string[];
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

const rebuildSteps = jobSteps(rebuildYml).rebuild;

/** The image repository the rebuild tags, as the meta step rows below expect it. */
const repository = 'ghcr.io/bitfloo/mailoo';

function images(...tags: string[]): string {
  return tags.map((tag) => `${repository}:${tag}`).join(',');
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

  it('should push the release and SHA images to the repository the rebuild tags', () => {
    // An image pushed anywhere else would sit beside the release tags instead of replacing them.
    const shaYml = readFileSync(join(workflowDir, 'docker-sha.yml'), 'utf8');
    const shaRepositories = Object.values(jobSteps(shaYml))
      .flat()
      .filter((step) => step.uses?.startsWith('docker/build-push-action@'))
      .map((step) => String(step.with?.tags).split(':')[0]);
    expect({
      release: goreleaserImages.map((image) => image.images),
      sha: shaRepositories,
    }).toEqual({
      release: [[repository], [repository]],
      sha: [repository],
    });
  });

  it('should set only the pinned keys on each GoReleaser image', () => {
    // skip_push or disable would let a release build an image and push none.
    expect(goreleaserImages.map((image) => Object.keys(image).sort())).toEqual(
      Array(2).fill([
        'annotations',
        'dockerfile',
        'extra_files',
        'id',
        'images',
        'labels',
        'platforms',
        'tags',
      ]),
    );
  });

  it('should use the GoReleaser tag names, Dockerfiles and architectures', () => {
    for (const id of ['mailoo-debian', 'mailoo-alpine']) {
      const image = goreleaserImages.find((entry) => entry.id === id);
      if (!image) {
        throw new Error(`missing goreleaser image ${id}`);
      }
      expect(rebuildYml, id).toContain(`file: ${image.dockerfile}\n`);
      expect(image.platforms).toEqual(['linux/amd64', 'linux/arm64']);
      for (const template of image.tags) {
        if (template.includes('ShortCommit')) {
          expect(rebuildYml).not.toContain('sha-${{');
          continue;
        }
        const needle = RELEASE_TAG_IN_REBUILD[template];
        expect(needle, template).toBeTruthy();
        expect(rebuildYml).toContain(needle);
      }
    }
    expect(rebuildYml.match(/platforms: linux\/amd64,linux\/arm64/g)).toHaveLength(2);
  });
});
