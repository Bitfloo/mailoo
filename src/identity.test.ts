import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ZodError } from 'zod';

import { loadConfig } from './config/loader.js';
import { OAuth2ConfigSchema } from './config/schema.js';
import OAuthService from './services/oauth.service.js';

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

  it('publishes each Dockerfile as one image described with the npm package description', async () => {
    // A commented-out label is not on the image.
    const live = async (file: string) =>
      (await readFile(join(root, file), 'utf8'))
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
    const descriptions = (text: string) =>
      [...text.matchAll(/org\.opencontainers\.image\.description[=:] ?"([^"]*)"/g)].map(
        (match) => match[1],
      );
    const images = (
      /^dockers_v2:\n((?: .*\n|\n)*)/m.exec(await live('.goreleaser.yaml'))?.[1] ?? ''
    )
      .split(/^ {2}- /m)
      .slice(1);
    const published = await Promise.all(
      images.map(async (image) => {
        const dockerfile = /^ *dockerfile: (\S+)$/m.exec(image)?.[1] ?? '';
        const text = await live(dockerfile);
        const block = (name: string) =>
          descriptions(new RegExp(`^ {4}${name}:\\n((?: {6}.*\\n)+)`, 'm').exec(image)?.[1] ?? '');
        // Only the last stage of a Dockerfile is the published image.
        const stage = descriptions(text.slice(text.lastIndexOf('\nFROM ')));
        return { dockerfile, stage, labels: block('labels'), annotations: block('annotations') };
      }),
    );
    const dockerfiles = (await readdir(root)).filter((file) => /^Dockerfile(?:\.|$)/.test(file));
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect(published.sort((a, b) => byName(a.dockerfile, b.dockerfile))).toEqual(
      dockerfiles.sort(byName).map((dockerfile) => ({
        dockerfile,
        stage: [pkg.description],
        labels: [pkg.description],
        annotations: [pkg.description],
      })),
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

describe('README Environment Variables table', () => {
  let readme: string;
  let rows: Map<string, { def: string; desc: string }>;
  let documented: string[];
  let read: string[];

  beforeAll(async () => {
    readme = await readFile(join(root, 'README.md'), 'utf8');
    const section = readme.split('#### Environment Variables')[1]?.split(/\n#{1,6} /)[0] ?? '';
    rows = new Map(
      [...section.matchAll(/^\| `(MCP_EMAIL_[A-Z0-9_]+)` \| (.*?) \| (.*) \|$/gm)].map((match) => [
        match[1],
        { def: match[2], desc: match[3] },
      ]),
    );
    documented = [...rows.keys()];
    read = await mcpEmailEnvNames();
  });

  it('should name only variables the server reads', () => {
    expect(documented.length).toBeGreaterThan(0);
    expect(documented.filter((name) => !read.includes(name))).toEqual([]);
  });

  it('should have a row for every MCP_EMAIL_OAUTH2_* variable the server reads', () => {
    const oauth2 = read.filter((name) => name.startsWith('MCP_EMAIL_OAUTH2_'));
    expect(oauth2.length).toBeGreaterThan(0);
    expect(oauth2.filter((name) => !documented.includes(name))).toEqual([]);
  });

  it('should have a row for MCP_EMAIL_PASSWORD and every variable an account cannot load without', () => {
    const needed = ['MCP_EMAIL_PASSWORD', ...REQUIRED_MCP_EMAIL_ENV];
    expect(needed.filter((name) => !documented.includes(name))).toEqual([]);
  });

  it('should list every MCP_EMAIL_OAUTH2_* variable the server reads in the grouped Environment reference', () => {
    const section = readme.split(/^### Environment$/m)[1]?.split(/\n#{1,3} /)[0] ?? '';
    const row = section.split('\n').find((line) => line.split('|')[2]?.trim().startsWith('OAuth2'));
    const listed = [...(row?.split('|')[1] ?? '').matchAll(/MCP_EMAIL_OAUTH2_[A-Z0-9_]+/g)]
      .map((match) => match[0])
      .sort();
    expect(listed).toEqual(read.filter((name) => name.startsWith('MCP_EMAIL_OAUTH2_')));
  });

  // Each claim a row makes is read off loadConfig, so a row cannot keep a claim the loader no longer makes.
  describe('against the loader', () => {
    const NO_CONFIG = 'No configuration found.';
    const PROVIDER = 'MCP_EMAIL_OAUTH2_PROVIDER';
    const PROVIDER_REFUSED = 'refuses accounts.0.oauth2.provider';
    type Env = Record<string, string | undefined>;
    type Loaded = Awaited<ReturnType<typeof loadConfig>>['accounts'][number] | undefined;
    const PASSWORD_ONLY: Env = {
      MCP_EMAIL_PASSWORD: 'app-password',
      MCP_EMAIL_OAUTH2_PROVIDER: undefined,
    };
    const CLIENT_FIELDS = [
      ['MCP_EMAIL_OAUTH2_CLIENT_ID', 'client_id'],
      ['MCP_EMAIL_OAUTH2_CLIENT_SECRET', 'client_secret'],
      ['MCP_EMAIL_OAUTH2_REFRESH_TOKEN', 'refresh_token'],
    ] as const;
    const NO_CLIENT_VALUES: Env = Object.fromEntries(
      CLIENT_FIELDS.map(([name]) => [name, undefined]),
    );
    let missingConfig: string;
    let dir: string;

    const providerDesc = (): string => rows.get(PROVIDER)?.desc ?? '';
    const backticked = (text: string): string[] =>
      [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const stub = (vars: Env): void => {
      Object.entries(vars).forEach(([name, value]) => {
        vi.stubEnv(name, value);
      });
    };
    const reading = (account: Loaded): string => {
      const block = account?.oauth2;
      return block ? `reads ${block.provider}` : 'no OAuth2';
    };
    const outcome = async (show: (account: Loaded) => string = () => 'loads'): Promise<string> => {
      try {
        return show((await loadConfig(missingConfig)).accounts[0]);
      } catch (error) {
        if (error instanceof ZodError) {
          return `refuses ${error.issues.map((issue) => issue.path.join('.')).join(', ')}`;
        }
        return String((error as Error).message).split('\n')[0];
      }
    };

    beforeEach(async () => {
      Object.keys(process.env)
        .filter((name) => name.startsWith('MCP_EMAIL_'))
        .forEach((name) => {
          vi.stubEnv(name, undefined);
        });
      // A complete OAuth2 account and no password; each test removes what it probes.
      stub({
        MCP_EMAIL_ADDRESS: 'owner@example.com',
        MCP_EMAIL_IMAP_HOST: 'imap.example.com',
        MCP_EMAIL_SMTP_HOST: 'smtp.example.com',
        MCP_EMAIL_OAUTH2_PROVIDER: 'google',
        MCP_EMAIL_OAUTH2_CLIENT_ID: 'client-id',
        MCP_EMAIL_OAUTH2_CLIENT_SECRET: 'client-secret',
        MCP_EMAIL_OAUTH2_REFRESH_TOKEN: 'refresh-token',
      });
      // Fresh empty directory: a file at a repo path would be read as the config.
      dir = await mkdtemp(join(tmpdir(), 'mailoo-readme-env-'));
      missingConfig = join(dir, 'no-such-config.toml');
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    });

    // The three client rows carry a condition and are read whole by the test below.
    const requirements: [string, Env, string][] = [
      ['MCP_EMAIL_PASSWORD', PASSWORD_ONLY, NO_CONFIG],
      // A password account loads without a provider, so the provider row must not say *required*.
      ['MCP_EMAIL_OAUTH2_PROVIDER', PASSWORD_ONLY, NO_CONFIG],
      ...REQUIRED_MCP_EMAIL_ENV.map((name): [string, Env, string] => [
        name,
        PASSWORD_ONLY,
        NO_CONFIG,
      ]),
    ];

    it.each(requirements)(
      'should mark %s *required* exactly when the loader refuses an account without it',
      async (name, account, refusal) => {
        stub({ ...account, [name]: undefined });
        const refused = (await outcome()) === refusal;
        expect(rows.get(name)?.def.startsWith('*required*')).toBe(refused);
      },
    );

    it('should name MCP_EMAIL_OAUTH2_PROVIDER in the MCP_EMAIL_PASSWORD row exactly when the provider alone lets an account load without a password', async () => {
      const withProvider = await outcome();
      stub({ MCP_EMAIL_OAUTH2_PROVIDER: undefined });
      const providerWaivesPassword = withProvider === 'loads' && (await outcome()) === NO_CONFIG;
      expect(rows.get('MCP_EMAIL_PASSWORD')?.desc.includes('`MCP_EMAIL_OAUTH2_PROVIDER`')).toBe(
        providerWaivesPassword,
      );
    });

    it('should mark MCP_EMAIL_PASSWORD *required* without OAuth2 exactly when only a provider lets an account load without it', async () => {
      const withProvider = await outcome();
      stub({ MCP_EMAIL_OAUTH2_PROVIDER: undefined });
      const onlyProviderWaives = withProvider === 'loads' && (await outcome()) === NO_CONFIG;
      expect(rows.get('MCP_EMAIL_PASSWORD')?.def === '*required* without OAuth2').toBe(
        onlyProviderWaives,
      );
    });

    it.each(CLIENT_FIELDS)(
      'should mark %s *required* with a provider exactly when the provider makes the loader refuse an account without it and a password account loads without all three',
      async (name, field) => {
        stub({ [name]: undefined });
        const refusedWithProvider = (await outcome()) === `refuses accounts.0.oauth2.${field}`;
        stub({ ...PASSWORD_ONLY, ...NO_CLIENT_VALUES });
        const loadsWithoutProvider = (await outcome()) === 'loads';
        expect(rows.get(name)?.def === '*required* with a provider').toBe(
          refusedWithProvider && loadsWithoutProvider,
        );
      },
    );

    it.each(
      CLIENT_FIELDS.flatMap(([name, field]) =>
        [undefined, ''].map((value) => [name, value, field] as const),
      ),
    )(
      'should say in the REFRESH_TOKEN row that a missing or empty client value is refused, naming the field, exactly when %s=%j is refused at %s',
      async (name, value, field) => {
        stub({ [name]: value });
        const refusedAtField = (await outcome()) === `refuses accounts.0.oauth2.${field}`;
        expect(
          rows
            .get('MCP_EMAIL_OAUTH2_REFRESH_TOKEN')
            ?.desc.includes(
              'A missing or empty client id, client secret or refresh token is refused when the configuration loads, naming the field',
            ),
        ).toBe(refusedAtField);
      },
    );

    describe('the MCP_EMAIL_OAUTH2_PROVIDER row', () => {
      const providerRead = async (
        value: string | undefined,
        account: Env = {},
      ): Promise<string> => {
        stub({ ...account, [PROVIDER]: value });
        return outcome(reading);
      };

      it('should list the providers the account schema names', () => {
        const listed = backticked(providerDesc().split(';')[0] ?? '');
        expect(listed).toEqual([...OAuth2ConfigSchema.shape.provider.options]);
      });

      it.each(OAuth2ConfigSchema.shape.provider.options)(
        'should say the provider is read exactly as set exactly when the loader reads %s as given',
        async (value) => {
          expect(providerDesc().includes('read exactly as set')).toBe(
            (await providerRead(value)) === `reads ${value}`,
          );
        },
      );

      it.each(['other', ' google ', 'Google'])(
        'should say any other value is refused exactly when the loader refuses %j at the provider',
        async (value) => {
          expect(providerDesc().includes('any other value is refused')).toBe(
            (await providerRead(value)) === PROVIDER_REFUSED,
          );
        },
      );

      it.each([undefined, ''])(
        'should say unset or empty means no OAuth2 exactly when a password account with the provider %j loads without OAuth2',
        async (value) => {
          expect(providerDesc().includes('Unset or empty means no OAuth2')).toBe(
            (await providerRead(value, { MCP_EMAIL_PASSWORD: 'app-password' })) === 'no OAuth2',
          );
        },
      );

      it('should say no environment variable can set the custom endpoints exactly when the environment gives a custom provider none, which the token service refuses', async () => {
        const family = read.filter((name) => name.startsWith('MCP_EMAIL_OAUTH2_'));
        stub(Object.fromEntries(family.map((name) => [name, `https://env.example.test/${name}`])));
        stub({ [PROVIDER]: 'custom' });
        const block = (await loadConfig(missingConfig)).accounts[0]?.oauth2;
        if (block === undefined) throw new Error('no OAuth2 block was loaded');
        const noEndpoints = block.tokenUrl === undefined && block.authUrl === undefined;
        expect(() => OAuthService.getProviderEndpoints(block)).toThrow(
          'Custom OAuth2 provider requires tokenUrl and authUrl',
        );
        expect(providerDesc().includes('which no environment variable can set')).toBe(noEndpoints);
      });

      it('should give a custom account its endpoints from the config file the row describes', async () => {
        const ticks = backticked(providerDesc());
        const keys = ticks.filter((tick) => /^[a-z]+_url$/.test(tick));
        expect(keys).toEqual(['token_url', 'auth_url']);
        const file = join(dir, 'config.toml');
        await writeFile(
          file,
          [
            '[[accounts]]',
            'name = "file"',
            'email = "file@example.com"',
            '',
            ticks.find((tick) => tick.startsWith('[accounts.')) ?? '',
            'provider = "custom"',
            'client_id = "file-id"',
            'client_secret = "file-secret"',
            'refresh_token = "file-refresh"',
            ...keys.map((key) => `${key} = "https://auth.example.test/${key}"`),
            '',
            '[accounts.imap]',
            'host = "imap.example.com"',
            '',
            '[accounts.smtp]',
            'host = "smtp.example.com"',
            '',
          ].join('\n'),
          { mode: 0o600 },
        );
        stub({ MCP_EMAIL_ADDRESS: undefined });
        const block = (await loadConfig(file)).accounts[0]?.oauth2;
        if (block === undefined) throw new Error('no OAuth2 block was loaded');
        expect(OAuthService.getProviderEndpoints(block)).toMatchObject({
          tokenUrl: 'https://auth.example.test/token_url',
          authUrl: 'https://auth.example.test/auth_url',
        });
      });
    });
  });
});
