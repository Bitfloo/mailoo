import fs from 'node:fs/promises';

import { parse as parseTOML } from 'smol-toml';

import { SettingsSchema } from '../config/schema.js';
import {
  CONFIG_FAILING_SCHEMA,
  CONFIG_WITH_PERSONAL,
  CONFIG_WITH_PERSONAL_AND_WORK,
  CONFIG_WITH_SYNTAX_ERROR,
} from '../test-support/account-config-fixtures.js';
import { useAccountSandbox } from '../test-support/cli-wizard.js';

const { wizard, probes } = await vi.hoisted(async () => {
  const { newWizardState, newProbes } = await import('../test-support/cli-wizard.js');
  return { wizard: newWizardState(), probes: newProbes() };
});

// The terminal UI and the network probe are the only boundaries replaced.
vi.mock('@clack/prompts', async () => {
  const { clackPromptsMock, ACCOUNT_ANSWERS } = await import('../test-support/cli-wizard.js');
  return clackPromptsMock(wizard, ACCOUNT_ANSWERS);
});
vi.mock('../connections/manager.js', () => ({ default: probes }));

describe('mailoo account and setup', () => {
  const sandbox = useAccountSandbox(wizard, probes);

  // The wizard read an unparseable file as "no config" and saved a new one
  // over it, which dropped every account the file held.
  it.each(['setup', 'account add'] as const)(
    'should reject with the TOML error when mailoo %s meets a config that is not valid TOML',
    async (command) => {
      await fs.writeFile(sandbox.configFile, CONFIG_WITH_SYNTAX_ERROR, { mode: 0o600 });
      const run = await sandbox.entryPoint(command);

      await expect(run()).rejects.toThrow(`Config file ${sandbox.configFile} is not valid TOML`);
    },
  );

  it.each(['setup', 'account add'] as const)(
    'should leave a config that is not valid TOML byte-identical when mailoo %s stops',
    async (command) => {
      await fs.writeFile(sandbox.configFile, CONFIG_WITH_SYNTAX_ERROR, { mode: 0o600 });
      const run = await sandbox.entryPoint(command);

      await run().catch(() => undefined);

      expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_WITH_SYNTAX_ERROR);
    },
  );

  it.each(['setup', 'account add'] as const)(
    'should reject with the schema error when mailoo %s meets a config that parses but is not valid',
    async (command) => {
      await fs.writeFile(sandbox.configFile, CONFIG_FAILING_SCHEMA, { mode: 0o600 });
      const run = await sandbox.entryPoint(command);

      await expect(run()).rejects.toThrow('Invalid email address');
    },
  );

  it.each(['setup', 'account add'] as const)(
    'should leave a config that parses but is not valid byte-identical when mailoo %s stops',
    async (command) => {
      await fs.writeFile(sandbox.configFile, CONFIG_FAILING_SCHEMA, { mode: 0o600 });
      const run = await sandbox.entryPoint(command);

      await run().catch(() => undefined);

      expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_FAILING_SCHEMA);
    },
  );

  it.each(['setup', 'account add'] as const)(
    'should leave the config byte-identical when mailoo %s meets an account name that already exists',
    async (command) => {
      const existing = CONFIG_WITH_PERSONAL.replace('"personal"', '"work"');
      await fs.writeFile(sandbox.configFile, existing, { mode: 0o600 });
      const run = await sandbox.entryPoint(command);

      await run();

      expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(existing);
    },
  );

  it('should append the new account and keep the existing accounts and settings when a valid config exists', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL, { mode: 0o600 });
    const run = await sandbox.entryPoint('account add');

    await run();

    const saved = parseTOML(await fs.readFile(sandbox.configFile, 'utf-8')) as {
      settings: { rate_limit: number };
      accounts: { name: string }[];
    };
    expect({
      rateLimit: saved.settings.rate_limit,
      names: saved.accounts.map((a) => a.name),
    }).toEqual({ rateLimit: 3, names: ['personal', 'work'] });
  });

  it('should write a new config with the schema settings when no config file exists', async () => {
    const run = await sandbox.entryPoint('account add');

    await run();

    const saved = parseTOML(await fs.readFile(sandbox.configFile, 'utf-8'));
    // Certificate checks stay on in every account the wizard writes.
    expect(saved).toEqual({
      settings: SettingsSchema.parse({}),
      accounts: [
        {
          name: 'work',
          email: 'user@example.com',
          username: 'user@example.com',
          password: 'app-password',
          imap: {
            host: 'imap.example.com',
            port: 993,
            tls: true,
            starttls: false,
            verify_ssl: true,
            disable_imap4rev2: false,
          },
          smtp: {
            host: 'smtp.example.com',
            port: 465,
            tls: true,
            starttls: false,
            verify_ssl: true,
            pool: { enabled: false, max_connections: 1, max_messages: 100 },
          },
        },
      ],
    });
  });

  it('should write a new config when mailoo setup runs with no config file', async () => {
    const run = await sandbox.entryPoint('setup');

    await run();

    const saved = parseTOML(await fs.readFile(sandbox.configFile, 'utf-8')) as {
      accounts: { name: string }[];
    };
    expect(saved.accounts.map((a) => a.name)).toEqual(['work']);
  });

  it.each([
    ['IMAP use TLS?', false, 'imap', { tls: false, starttls: true }],
    ['SMTP security', 'starttls', 'smtp', { tls: false, starttls: true }],
    ['SMTP security', 'none', 'smtp', { tls: false, starttls: false }],
  ] as const)('should write the %s answer %s as %s %o', async (prompt, value, side, flags) => {
    wizard.overrides.set(prompt, value);
    const run = await sandbox.entryPoint('account add');

    await run();

    const saved = parseTOML(await fs.readFile(sandbox.configFile, 'utf-8')) as {
      accounts: Record<'imap' | 'smtp', { tls: boolean; starttls: boolean }>[];
    };
    const { tls, starttls } = saved.accounts[0][side];
    expect({ tls, starttls }).toEqual(flags);
  });

  it('should hand the connection probe the TLS answer and certificate checks on', async () => {
    await (await sandbox.entryPoint('account add'))();

    const [account] = probes.testImap.mock.lastCall ?? [];
    expect({ imap: account?.imap, smtpVerifySsl: account?.smtp.verifySsl }).toEqual({
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtpVerifySsl: true,
    });
  });

  it('should leave the config byte-identical when the probe fails and saving anyway is declined', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL, { mode: 0o600 });
    probes.testImap.mockResolvedValueOnce({ success: false, error: 'Connection refused' });
    wizard.overrides.set('Some connections failed. Save config anyway?', false);

    await (await sandbox.entryPoint('account add'))();

    expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL);
  });

  it('should refuse to delete the last account and leave the config byte-identical', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL, { mode: 0o600 });
    const run = await sandbox.entryPoint('account delete', 'personal');

    await run();

    expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL);
  });

  it('should remove only the named account and keep the other when delete is confirmed', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL_AND_WORK, { mode: 0o600 });
    const run = await sandbox.entryPoint('account delete', 'personal');

    await run();

    const saved = parseTOML(await fs.readFile(sandbox.configFile, 'utf-8')) as {
      accounts: { name: string }[];
    };
    expect(saved.accounts.map((a) => a.name)).toEqual(['work']);
  });

  it.each([
    ['declined', false],
    ['cancelled with Ctrl-C', Symbol('clack:cancel')],
  ])('should keep both accounts byte-identical when delete is %s', async (_, reply) => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL_AND_WORK, { mode: 0o600 });
    wizard.overrides.set(
      'Delete account "personal" (me@example.com)? This cannot be undone.',
      reply,
    );
    const run = await sandbox.entryPoint('account delete', 'personal');

    await run();

    expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL_AND_WORK);
  });

  it('should list an account with TLS for IMAP and STARTTLS for SMTP when it is set up that way', async () => {
    const smtp = 'host = "smtp.example.com"';
    const config = CONFIG_WITH_PERSONAL.replace(
      smtp,
      `${smtp}\nport = 587\ntls = false\nstarttls = true`,
    );
    await fs.writeFile(sandbox.configFile, config, { mode: 0o600 });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await (await sandbox.entryPoint('account list'))();

    expect(stdout.mock.calls.flat().join('\n')).toMatch(
      /imap\.example\.com:993 \(TLS\) +smtp\.example\.com:587 \(STARTTLS\)/,
    );
    stdout.mockRestore();
  });

  it("should refuse an edit that renames an account to another account's name", async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL_AND_WORK, { mode: 0o600 });
    const run = await sandbox.entryPoint('account edit', 'personal');

    await run();

    expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL_AND_WORK);
  });

  it('should replace only the second account when it is the one edited', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL_AND_WORK, { mode: 0o600 });
    wizard.overrides.set('Editing "work" — what would you like to change?', 'identity');

    await (await sandbox.entryPoint('account edit', 'work'))();

    const saved = parseTOML(await fs.readFile(sandbox.configFile, 'utf-8')) as {
      accounts: { name: string; email: string }[];
    };
    expect(saved.accounts.map((a) => `${a.name} ${a.email}`)).toEqual([
      'personal me@example.com',
      'work user@example.com',
    ]);
  });
});
