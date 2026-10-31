import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { repoRoot } from './agents/agent-file.js';
import { jobSteps, workflowDir } from './workflow-yaml.js';

interface GoreleaserImage {
  id: string;
  dockerfile: string;
  extra_files: string[];
  images: string[];
  platforms: string[];
  tags: string[];
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

const goreleaser = parse(readFileSync(join(repoRoot, '.goreleaser.yaml'), 'utf8')) as Record<
  string,
  unknown
> & { dockers_v2: GoreleaserImage[] };
const goreleaserImages = goreleaser.dockers_v2;

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
  description: string;
  license: string;
};

function goreleaserImage(id: string): GoreleaserImage {
  const image = goreleaserImages.find((entry) => entry.id === id);
  if (!image) {
    throw new Error(`missing goreleaser image ${id}`);
  }
  return image;
}

/** A GoReleaser tag template as a release of `version` renders it. The commit is left a template. */
function render(template: string, version: string): string {
  const [major, minor] = version.split('.');
  const rendered = template
    .replaceAll('{{ .Version }}', version)
    .replaceAll('{{ .Major }}', major)
    .replaceAll('{{ .Minor }}', minor)
    .replace(/\{\{ if not \.Prerelease \}\}(\w+)\{\{ end \}\}/g, version.includes('-') ? '' : '$1');
  if (rendered.replaceAll('{{ .ShortCommit }}', '').includes('{{')) {
    throw new Error(`cannot render ${template}`);
  }
  return rendered;
}

/** Each build-context path a Dockerfile copies: every COPY source but those from another stage. */
function copySources(dockerfile: string): string[] {
  return readFileSync(join(repoRoot, dockerfile), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('COPY ') && !line.includes('--from='))
    .flatMap((line) =>
      line
        .split(/\s+/)
        .slice(1, -1)
        .filter((word) => !word.startsWith('--')),
    );
}

const repository = 'ghcr.io/bitfloo/mailoo';

describe('release images', () => {
  it('should push the release and SHA images to the repository the README names', () => {
    // Each release pushes a sha- tag here too, so an on-demand SHA image pushed elsewhere would
    // split the sha- tags across two packages.
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
    // disable would let a release skip an image and push none.
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

  it.each([
    {
      id: 'mailoo-debian',
      version: '1.4.2',
      tags: [
        '1.4.2',
        '1.4.2-bookworm',
        '1.4',
        '1.4-bookworm',
        '1',
        '1-bookworm',
        'bookworm',
        'latest',
        'sha-{{ .ShortCommit }}',
      ],
    },
    {
      id: 'mailoo-debian',
      version: '1.5.0-rc.1',
      tags: [
        '1.5.0-rc.1',
        '1.5.0-rc.1-bookworm',
        '1.5',
        '1.5-bookworm',
        '1',
        '1-bookworm',
        'bookworm',
        'sha-{{ .ShortCommit }}',
      ],
    },
    {
      id: 'mailoo-alpine',
      version: '1.4.2',
      tags: ['1.4.2-alpine', '1.4-alpine', '1-alpine', 'alpine'],
    },
    {
      id: 'mailoo-alpine',
      version: '1.5.0-rc.1',
      tags: ['1.5.0-rc.1-alpine', '1.5-alpine', '1-alpine'],
    },
  ])('should give the $id image its tag set for release $version', ({ id, version, tags }) => {
    // GoReleaser skips a tag that renders empty, which is how a release candidate leaves latest and
    // alpine on the last stable release.
    const rendered = goreleaserImage(id).tags.map((tag) => render(tag, version));
    expect(rendered.filter(Boolean).sort()).toEqual([...tags].sort());
  });

  it('should build the bookworm image from Dockerfile and the alpine one from Dockerfile.alpine', () => {
    // A swap would publish one base image under the other's tags.
    expect(goreleaserImages.map((image) => [image.id, image.dockerfile])).toEqual([
      ['mailoo-debian', 'Dockerfile'],
      ['mailoo-alpine', 'Dockerfile.alpine'],
    ]);
  });

  it('should build both release images for linux/amd64 and linux/arm64', () => {
    // README.md promises both architectures.
    expect(goreleaserImages.map((image) => image.platforms)).toEqual(
      Array(2).fill(['linux/amd64', 'linux/arm64']),
    );
  });

  it.each(['mailoo-debian', 'mailoo-alpine'])(
    'should hand GoReleaser every file the %s Dockerfile copies',
    (id) => {
      // GoReleaser builds from a context that holds only extra_files, so a file left out fails
      // the release image build.
      const image = goreleaserImage(id);
      const sources = copySources(image.dockerfile);
      expect({
        read: sources.length > 0,
        missing: sources.filter((source) => !image.extra_files.includes(source)),
      }).toEqual({ read: true, missing: [] });
    },
  );

  it('should label both release images with the pinned OCI metadata', () => {
    // The registry shows these on the package page, and version, revision and created tie an
    // image to its release.
    const labels = {
      'org.opencontainers.image.title': 'Mailoo',
      'org.opencontainers.image.description': pkg.description,
      'org.opencontainers.image.url': 'https://github.com/bitfloo/mailoo',
      'org.opencontainers.image.source': 'https://github.com/bitfloo/mailoo',
      'org.opencontainers.image.version': '{{ .Version }}',
      'org.opencontainers.image.revision': '{{ .FullCommit }}',
      'org.opencontainers.image.created': '{{ .Date }}',
      'org.opencontainers.image.licenses': pkg.license,
      'org.opencontainers.image.vendor': 'Bitfloo',
    };
    expect(goreleaserImages.map((image) => image.labels)).toEqual([labels, labels]);
  });

  it('should annotate each release image only with values its labels hold', () => {
    expect(
      goreleaserImages.map((image) =>
        Object.entries(image.annotations).filter(([key, value]) => image.labels[key] !== value),
      ),
    ).toEqual([[], []]);
  });

  it('should set only the pinned top-level keys in .goreleaser.yaml', () => {
    // A top-level key such as dockers, docker_manifests or publishers would push or publish
    // something no release test reads.
    expect(Object.keys(goreleaser).sort()).toEqual([
      'builds',
      'dockers_v2',
      'project_name',
      'release',
      'version',
    ]);
  });

  it('should use the version 2 GoReleaser config format', () => {
    expect(goreleaser.version).toBe(2);
  });

  it('should name the project mailoo and build no binary', () => {
    // The images build from the Dockerfiles; npm publishes the package from release.yml.
    expect([goreleaser.project_name, goreleaser.builds]).toEqual(['mailoo', [{ skip: true }]]);
  });
});
