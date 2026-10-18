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

/** A GoReleaser tag template as a 1.4.2 release renders it. The commit is left a template. */
function renderFor142(template: string): string {
  const rendered = template
    .replaceAll('{{ .Version }}', '1.4.2')
    .replaceAll('{{ .Major }}', '1')
    .replaceAll('{{ .Minor }}', '4')
    .replace(/\{\{ if not \.Prerelease \}\}(\w+)\{\{ end \}\}/g, '$1');
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

const rebuildSteps = jobSteps(rebuildYml).rebuild;
const rebuildBuilds = rebuildSteps
  .filter((step) => step.uses?.startsWith('docker/build-push-action@'))
  .map((step) => step.with ?? {});

const repository = 'ghcr.io/bitfloo/mailoo';

function images(...tags: string[]): string {
  return tags.map((tag) => `${repository}:${tag}`).join(',');
}

describe('docker rebuild images', () => {
  it('should hand each Dockerfile its own tag list and push it', () => {
    const builds = rebuildBuilds.map((input) => [
      input.file,
      String(input.tags).match(/^\$\{\{ steps\.meta\.outputs\.(\w+) \}\}$/)?.[1],
      input.push,
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
    // The rebuild refreshes the tags in this repository, so a release image pushed elsewhere would
    // never be refreshed. Each release pushes a sha- tag here too, so an on-demand SHA image pushed
    // elsewhere would split the sha- tags across two packages.
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
    { id: 'mailoo-debian', output: 'bookworm_tags', releaseOnly: ['sha-{{ .ShortCommit }}'] },
    { id: 'mailoo-alpine', output: 'alpine_tags', releaseOnly: [] },
  ])('should give the $id release image the tags the rebuild writes for 1.4.2', (row) => {
    // The rebuild refreshes the tags a release pushed, so a tag only one of them writes is never
    // refreshed or never published. The sha- tag names one release commit and is not refreshed.
    const written = meta({ version: '1.4.2' }).outputs[row.output].split(',');
    const rebuilt = written.map((image) => image.slice(`${repository}:`.length));
    expect(goreleaserImage(row.id).tags.map(renderFor142).sort()).toEqual(
      [...rebuilt, ...row.releaseOnly].sort(),
    );
  });

  it('should build each release image from the Dockerfile the rebuild uses for its tags', () => {
    const fileFor = Object.fromEntries(
      rebuildBuilds.map((input) => [String(input.tags).match(/outputs\.(\w+)/)?.[1], input.file]),
    );
    expect(goreleaserImages.map((image) => [image.id, image.dockerfile])).toEqual([
      ['mailoo-debian', fileFor.bookworm_tags],
      ['mailoo-alpine', fileFor.alpine_tags],
    ]);
  });

  it('should build each release image for the architectures the rebuild builds', () => {
    expect(goreleaserImages.map((image) => image.platforms.join(','))).toEqual(
      rebuildBuilds.map((input) => input.platforms),
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
