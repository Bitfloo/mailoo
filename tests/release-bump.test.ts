import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { repoRoot as root } from './agents/agent-file.js';

const execFileAsync = promisify(execFile);

/** `X.Y` of a release: goreleaser moves the image tag of that name on every X.Y.z release. */
function minorLine(version: string): string {
  return version.split('.').slice(0, 2).join('.');
}

function readmeImageTags(readme: string): string[] {
  return [...readme.matchAll(/ghcr\.io\/bitfloo\/mailoo:([\w.-]+)/g)].map((match) => match[1]);
}

function cogPreBumpHookLists(cog: string): string[][] {
  return [...cog.matchAll(/^pre_bump_hooks = \[([\s\S]*?)\]$/gm)].map((list) =>
    [...list[1].matchAll(/"([^"]*)"/g)].map((hook) => hook[1]),
  );
}

/** Run the README stamp in a scratch dir holding `readme`; rejects on a non-zero exit. */
async function runStamp(
  readme: string,
  version: string,
): Promise<{ readme: string; files: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'mailoo-readme-tag-'));
  try {
    await writeFile(join(dir, 'README.md'), readme);
    await execFileAsync('bash', [join(root, 'scripts/bump-readme-image-tag.sh'), version], {
      cwd: dir,
      env: { PATH: process.env.PATH },
    });
    return { readme: await readFile(join(dir, 'README.md'), 'utf8'), files: await readdir(dir) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function stampReadme(readme: string, version: string): Promise<string> {
  return (await runStamp(readme, version)).readme;
}

describe('release bump', () => {
  let pkg: { version: string };

  beforeAll(async () => {
    pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
  });

  it('pulls the image of the current minor line in the README Docker examples', async () => {
    const tags = readmeImageTags(await readFile(join(root, 'README.md'), 'utf8'));
    expect(tags.length).toBeGreaterThan(0);
    expect([...new Set(tags)]).toEqual([minorLine(pkg.version)]);
  });

  it('names the current minor line where the README explains the image tags', async () => {
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    const line = minorLine(pkg.version);
    expect(readme).toContain(`The \`${line}\` tag follows the newest ${line}.x release.`);
  });

  it('checks, builds and stamps the release before cog bumps it', async () => {
    // A minor bump would otherwise leave the README on the old line, and the pre-push tests would stop the release push.
    // One list: a bump profile's own hooks would replace these.
    expect(cogPreBumpHookLists(await readFile(join(root, 'cog.toml'), 'utf8'))).toEqual([
      [
        'pnpm check',
        'pnpm build',
        'npm pkg set version={{version}}',
        'bash scripts/bump-server-json-version.sh {{version}}',
        'bash scripts/bump-readme-image-tag.sh {{version}}',
        'bash scripts/tidy-changelog-entry.sh {{latest}} {{version}}',
        'git add package.json server.json README.md',
      ],
    ]);
  });

  it('should bump only the patch for a feature commit', async () => {
    // Mailoo is on 0.x, where a feature ships as a patch; a minor bump would also move the README image tag.
    const cog = await readFile(join(root, 'cog.toml'), 'utf8');
    const bumps = [...cog.matchAll(/^(\w+) = \{([^}]*)\}$/gm)].flatMap(([, type, keys]) =>
      [...keys.matchAll(/\b(bump_\w+) = true\b/g)].map(([, key]) => `${type} ${key}`),
    );
    expect(bumps).toEqual(['feat bump_patch']);
  });

  describe('when the README image tag is stamped for a release', () => {
    let readme: string;
    let stamped: string;

    beforeAll(async () => {
      readme = await readFile(join(root, 'README.md'), 'utf8');
      stamped = await stampReadme(readme, '1.4.2');
    });

    it('should move every image tag to the minor line of the release version', () => {
      expect(readmeImageTags(stamped)).toEqual(readmeImageTags(readme).map(() => '1.4'));
    });

    it('should name the new minor line in the tag explanation', () => {
      expect(stamped).toContain('The `1.4` tag follows the newest 1.4.x release.');
    });

    it('should leave everything but the minor line as it was', () => {
      const mask = (text: string) =>
        text
          .replace(/(mailoo:)\d+\.\d+/g, '$1X.Y')
          .replace(
            /`\d+\.\d+` tag follows the newest \d+\.\d+\.x/g,
            '`X.Y` tag follows the newest X.Y.x',
          );
      expect(mask(stamped)).toBe(mask(readme));
    });

    it('should move the alpine tag of the minor line', async () => {
      await expect(
        stampReadme('docker pull ghcr.io/bitfloo/mailoo:0.2-alpine\n', '1.4.2'),
      ).resolves.toBe('docker pull ghcr.io/bitfloo/mailoo:1.4-alpine\n');
    });

    it('should leave nothing but README.md behind', async () => {
      await expect(runStamp(readme, '1.4.2')).resolves.toMatchObject({ files: ['README.md'] });
    });

    it('should move every tag on a line that names two', async () => {
      const line = (minor: string) =>
        `Pull \`ghcr.io/bitfloo/mailoo:${minor}\` or \`ghcr.io/bitfloo/mailoo:${minor}-alpine\`.\n`;
      await expect(stampReadme(line('0.2'), '1.4.2')).resolves.toBe(line('1.4'));
    });

    it('should leave the tags of other images alone', async () => {
      const others = 'docker pull ghcr.io/example/mailoo:0.2\nimage: postgres:16.1\n';
      await expect(stampReadme(others, '1.4.2')).resolves.toBe(others);
    });

    it.each([
      '0.10.0',
      '0.2.10',
      '10.0.0',
    ])('should take release %s, whatever its digit counts', async (version) => {
      const tags = readmeImageTags(await stampReadme(readme, version));
      expect(tags).toEqual(readmeImageTags(readme).map(() => minorLine(version)));
    });

    it.each([
      ['0.10', '0.11.0'],
      ['10.2', '11.0.0'],
    ])('should move a README on the %s line to release %s', async (from, version) => {
      const line = (minor: string) =>
        `docker pull ghcr.io/bitfloo/mailoo:${minor}\nThe \`${minor}\` tag follows the newest ${minor}.x release.\n`;
      await expect(stampReadme(line(from), version)).resolves.toBe(line(minorLine(version)));
    });

    it.each([
      '0.2.1',
      '0.10.1',
    ])('should keep the full-version pin %s on its release', async (version) => {
      const pinned = `docker pull ghcr.io/bitfloo/mailoo:${version}\n`;
      await expect(stampReadme(pinned, '1.4.2')).resolves.toBe(pinned);
    });

    it.each([
      'v1.4.2',
      '1.4',
      'latest',
      '1x4.2',
      '1.4.x',
      '1.4x2',
      '1.42',
      '1.4.2x',
      '1.4.',
      '.4.2',
      '1..2',
      '1.4.2-rc.1',
    ])('should refuse %s as a release version', async (version) => {
      await expect(stampReadme(readme, version)).rejects.toThrow(/not a release version/);
    });
  });
});
