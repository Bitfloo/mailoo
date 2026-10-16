import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface PackageIdentity {
  name: string;
  version: string;
  mcpName: string;
  description: string;
  repository: { url: string };
}

interface ServerEnvVar {
  name: string;
  description: string;
  isRequired: boolean;
  isSecret: boolean;
}

interface ServerPackage {
  registryType: string;
  identifier: string;
  version: string;
  runtimeHint?: string;
  transport: { type: string };
  packageArguments?: unknown;
  environmentVariables?: ServerEnvVar[];
}

interface ServerIdentity {
  name: string;
  version: string;
  description: string;
  packages?: ServerPackage[];
}

const REQUIRED_MCP_EMAIL_ENV = [
  'MCP_EMAIL_ADDRESS',
  'MCP_EMAIL_IMAP_HOST',
  'MCP_EMAIL_SMTP_HOST',
] as const;

/** Password, client secret, refresh token, HTTP token, and webhook URL. */
const SECRET_ENV_NAME = /(?:^|_)(?:PASSWORD|SECRET|TOKEN)$|WEBHOOK_URL$/;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__integration__') return [];
        return sourceFiles(full);
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
      return [full];
    }),
  );
  return groups.flat();
}

/** `X.Y` of a release: goreleaser moves the image tag of that name on every X.Y.z release. */
function minorLine(version: string): string {
  return version.split('.').slice(0, 2).join('.');
}

function readmeImageTags(readme: string): string[] {
  return [...readme.matchAll(/ghcr\.io\/bitfloo\/mailoo:([\w.-]+)/g)].map((match) => match[1]);
}

/** Run the README stamp in a scratch dir holding `readme`; rejects on a non-zero exit. */
async function stampReadme(readme: string, version: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mailoo-readme-tag-'));
  try {
    await writeFile(join(dir, 'README.md'), readme);
    await execFileAsync('bash', [join(root, 'scripts/bump-readme-image-tag.sh'), version], {
      cwd: dir,
    });
    return await readFile(join(dir, 'README.md'), 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function mcpEmailEnvNames(): Promise<string[]> {
  const files = await sourceFiles(join(root, 'src'));
  const names = new Set<string>();
  const texts = await Promise.all(files.map(async (file) => readFile(file, 'utf8')));
  texts.forEach((text) => {
    [...text.matchAll(/(?:process\.env|\benv)\.(MCP_EMAIL_[A-Z0-9_]+)/g)].forEach((match) => {
      names.add(match[1]);
    });
  });
  return [...names].sort();
}

describe('published identity', () => {
  let pkg: PackageIdentity;
  let server: ServerIdentity;
  let smithery: string;

  beforeAll(async () => {
    pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageIdentity;
    server = JSON.parse(await readFile(join(root, 'server.json'), 'utf8')) as ServerIdentity;
    smithery = await readFile(join(root, 'smithery.yaml'), 'utf8');
  });

  it('publishes as Mailoo', () => {
    expect(pkg.name).toBe('@bitfloo/mailoo');
    expect(pkg.mcpName).toBe('io.github.Bitfloo/mailoo');
  });

  it('names the repository with the owner casing npm provenance and the MCP registry check', () => {
    // Both compare case-sensitively against the OIDC claim (Bitfloo/mailoo); v0.1.3 got E422 on bitfloo.
    const owner = pkg.mcpName.slice('io.github.'.length).split('/')[0];
    expect(pkg.repository.url).toBe(`git+https://github.com/${owner}/mailoo.git`);
    expect((server as unknown as { repository: { url: string } }).repository.url).toBe(
      `https://github.com/${owner}/mailoo.git`,
    );
  });

  it('describes the container images with the npm package description', async () => {
    const files = ['Dockerfile', 'Dockerfile.alpine', '.goreleaser.yaml'];
    const texts = await Promise.all(files.map(async (file) => readFile(join(root, file), 'utf8')));
    const found = texts.flatMap((text, i) =>
      [...text.matchAll(/org\.opencontainers\.image\.description[=:] ?"([^"]*)"/g)].map((match) => [
        files[i],
        match[1],
      ]),
    );
    // .goreleaser.yaml sets it as a label and as an annotation on each of the two images.
    expect(found).toEqual([
      ['Dockerfile', pkg.description],
      ['Dockerfile.alpine', pkg.description],
      ...Array.from({ length: 4 }, () => ['.goreleaser.yaml', pkg.description]),
    ]);
  });

  it('keeps server.json bound to the published npm package', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.description).toBe(pkg.description);
    expect(server.packages).toHaveLength(1);
    const entry = server.packages?.[0];
    expect(entry?.registryType).toBe('npm');
    expect(entry?.identifier).toBe(pkg.name);
    expect(entry?.version).toBe(pkg.version);
    expect(entry?.runtimeHint).toBe('npx');
    // src/main.ts defaults the subcommand to stdio, so the registry entry does not pass one.
    expect(entry?.transport).toEqual({ type: 'stdio' });
    expect(entry?.packageArguments).toBeUndefined();
  });

  it('lists every MCP_EMAIL_* variable the server reads, with secrets marked', async () => {
    const declared = server.packages?.[0]?.environmentVariables ?? [];
    const read = await mcpEmailEnvNames();
    expect(declared.map((item) => item.name).sort()).toEqual(read);
    declared.forEach((item) => {
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.isRequired).toBe(
        (REQUIRED_MCP_EMAIL_ENV as readonly string[]).includes(item.name),
      );
      expect(item.isSecret).toBe(SECRET_ENV_NAME.test(item.name));
    });
  });

  it('should set every packages[].version when the release version changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mailoo-server-json-'));
    const fixture = {
      version: '0.0.1',
      packages: [
        { registryType: 'npm', identifier: '@bitfloo/mailoo', version: '0.0.1' },
        { registryType: 'npm', identifier: 'other', version: '0.0.1' },
      ],
    };
    await writeFile(join(dir, 'server.json'), `${JSON.stringify(fixture, null, 2)}\n`);
    try {
      await execFileAsync('bash', [join(root, 'scripts/bump-server-json-version.sh'), '9.9.9'], {
        cwd: dir,
      });
      const updated = JSON.parse(await readFile(join(dir, 'server.json'), 'utf8')) as {
        version: string;
        packages: { version: string; identifier: string }[];
      };
      expect(updated.version).toBe('9.9.9');
      expect(updated.packages.map((item) => item.version)).toEqual(['9.9.9', '9.9.9']);
      expect(updated.packages.map((item) => item.identifier)).toEqual(['@bitfloo/mailoo', 'other']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  it('runs the same release stamps in every cog bump profile', async () => {
    // A minor bump would otherwise leave the README on the old line, and the pre-push tests would stop the release push.
    const cog = await readFile(join(root, 'cog.toml'), 'utf8');
    const profiles = [...cog.matchAll(/^pre_bump_hooks = \[([\s\S]*?)\]$/gm)].map((match) =>
      [...match[1].matchAll(/"([^"]*)"/g)].map((hook) => hook[1]),
    );
    const stamps = [
      'npm pkg set version={{version}}',
      'bash scripts/bump-server-json-version.sh {{version}}',
      'bash scripts/bump-readme-image-tag.sh {{version}}',
      'bash scripts/tidy-changelog-entry.sh {{latest}} {{version}}',
      'git add package.json server.json README.md',
    ];
    const profileCount = 1 + (cog.match(/^\[bump_profiles\.[\w-]+\]$/gm)?.length ?? 0);
    expect(profiles.map((hooks) => hooks.slice(hooks.indexOf(stamps[0])))).toEqual(
      Array.from({ length: profileCount }, () => stamps),
    );
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

    it('should keep a full-version pin on its release', async () => {
      const pinned = 'docker pull ghcr.io/bitfloo/mailoo:0.2.1\n';
      await expect(stampReadme(pinned, '1.4.2')).resolves.toBe(pinned);
    });

    it.each([
      'v1.4.2',
      '1.4',
      'latest',
    ])('should refuse %s as a release version', async (version) => {
      await expect(stampReadme(readme, version)).rejects.toThrow(/not a semver version/);
    });
  });

  it('launches smithery with npx and maps config onto MCP_EMAIL_* variables', () => {
    expect(smithery).toContain('npx');
    expect(smithery).toContain(pkg.name);
    expect(smithery).not.toMatch(/not on npm/i);
    expect(smithery).not.toContain('dist/main.js');
    const names = server.packages?.[0]?.environmentVariables?.map((item) => item.name) ?? [];
    expect(names.length).toBeGreaterThan(0);
    names.forEach((name) => {
      expect(smithery).toContain(name);
    });
  });

  it('copies each server.json environment description into smithery.yaml', () => {
    // The registry and Smithery are published apart; an edit to one would describe the same variable two ways.
    const declared = server.packages?.[0]?.environmentVariables ?? [];
    expect(declared.length).toBeGreaterThan(0);
    declared.forEach((item) => {
      const marker = `\n      ${item.name}:\n`;
      const start = smithery.indexOf(marker);
      const rest = start < 0 ? '' : smithery.slice(start + marker.length);
      const next = rest.search(/\n {6}[A-Z0-9_]+:\n|\n {4}\S/);
      const block = next < 0 ? rest : rest.slice(0, next);
      expect(block).toContain(`description: "${item.description}"`);
    });
  });

  it('documents npx as an install path and does not say the package is unpublished', async () => {
    const readme = await readFile(join(root, 'README.md'), 'utf8');
    expect(readme).toContain('npx -y @bitfloo/mailoo');
    expect(readme).toContain('ghcr.io/bitfloo/mailoo');
    expect(readme).not.toMatch(/not on npm/i);
    expect(readme).not.toMatch(/npx @bitfloo\/mailoo` will fail/);
    expect(readme).not.toMatch(/until npm/i);
  });
});
