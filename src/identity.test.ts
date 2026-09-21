import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface PackageIdentity {
  name: string;
  version: string;
  mcpName: string;
  description: string;
}

interface ServerIdentity {
  name: string;
  version: string;
  description: string;
  packages: { identifier: string; version: string }[];
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
    expect(pkg.mcpName).toBe('io.github.bitfloo/mailoo');
  });

  it('keeps server.json bound to package.json', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.description).toBe(pkg.description);
    expect(server.packages[0]?.identifier).toBe(pkg.name);
    expect(server.packages[0]?.version).toBe(pkg.version);
  });

  it('does not advertise npx while the package is unpublished', () => {
    expect(JSON.stringify(server)).not.toContain('npx');
  });

  it('keeps smithery on the npm package name without pretending npx works', () => {
    expect(smithery).toContain(pkg.name);
    expect(smithery).toContain('node');
    expect(smithery).toContain('dist/main.js');
    expect(smithery).not.toMatch(/"npx"/);
  });
});
