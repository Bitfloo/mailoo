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

  it('keeps smithery on the npm package name without pretending npx works', () => {
    expect(smithery).toContain(pkg.name);
    expect(smithery).toContain('node');
    expect(smithery).toContain('dist/main.js');
    expect(smithery).not.toMatch(/"npx"/);
  });
});
