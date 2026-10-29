import fs from 'node:fs/promises';

import { note } from '@clack/prompts';
import { parse as parseTOML } from 'smol-toml';
import { ZodError } from 'zod';

import { SettingsSchema } from '../config/schema.js';
import {
  CONFIG_FAILING_SCHEMA,
  CONFIG_WITH_PERSONAL,
  CONFIG_WITH_SYNTAX_ERROR,
} from '../test-support/account-config-fixtures.js';
import type { Answer } from '../test-support/cli-wizard.js';
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
vi.mock('../connections/probe.js', () => probes);

/** Each differs from its default, so a field taken from the wrong answer shows. */
const CUSTOM_ANSWERS: Record<string, Answer> = {
  'Full name (optional)': 'Ada Example',
  'IMAP host': 'mail.example.com',
  'IMAP port': '143',
  'IMAP use TLS?': false,
  'SMTP host': 'relay.example.com',
  'SMTP port': '587',
  'SMTP security': 'starttls',
  'Enable SMTP connection pooling?': true,
  'SMTP pool max connections': '3',
  'SMTP pool max messages per connection': '50',
  Username: 'ada.login',
  'Password / App Password': 'other-app-password',
};

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

  // The global `mailoo` command never updates, and an npx user does not have it on PATH.
  it('should print the npx @latest client entry after mailoo account add saves the account', async () => {
    const run = await sandbox.entryPoint('account add');

    await run();

    const printed = vi
      .mocked(note)
      .mock.calls.map(([message]) => String(message))
      .find((message) => message.includes('mcpServers'));
    expect(JSON.parse(printed ?? '{}')).toEqual({
      mcpServers: { mailoo: { command: 'npx', args: ['-y', '@bitfloo/mailoo@latest', 'stdio'] } },
    });
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

  it('should print the subcommand usage when mailoo account gets no subcommand', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await (await sandbox.entryPoint('account'))();

    expect(stdout.mock.calls.flat().join('\n')).toContain('Usage: mailoo account <subcommand>');
  });

  it.each([
    ['IMAP use TLS?', false, 'imap', { tls: false, starttls: true }],
    ['SMTP security', 'starttls', 'smtp', { tls: false, starttls: true }],
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

  describe('with SMTP security None', () => {
    beforeEach(() => {
      wizard.overrides.set('SMTP security', 'none');
    });

    it('should refuse a remote SMTP host, naming the account, host and fix', async () => {
      const run = await sandbox.entryPoint('account add');

      const refused = await run().then(
        () => [],
        (error: unknown) => {
          if (!(error instanceof ZodError)) throw error;
          return error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
        },
      );

      expect(refused).toEqual([
        'accounts.0.smtp.tls: Account "work": SMTP to "smtp.example.com" would be unencrypted ' +
          '(tls = false and starttls = false). Set tls = true or starttls = true, ' +
          'or use a loopback host (localhost, 127.0.0.0/8 or ::1).',
      ]);
    });

    it('should leave the config byte-identical when the SMTP host is remote', async () => {
      await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL, { mode: 0o600 });
      const run = await sandbox.entryPoint('account add');

      await run().catch(() => undefined);

      expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL);
    });

    // The probe logs in, so a refused account must not reach it.
    it('should not probe either server when the SMTP host is remote', async () => {
      const run = await sandbox.entryPoint('account add');

      await run().catch(() => undefined);

      expect({
        imap: probes.testImap.mock.calls,
        smtp: probes.testSmtp.mock.calls,
      }).toEqual({ imap: [], smtp: [] });
    });

    it('should write tls = false and starttls = false when the SMTP host is 127.0.0.1', async () => {
      wizard.overrides.set('SMTP host', '127.0.0.1');
      const run = await sandbox.entryPoint('account add');

      await run();

      const saved = parseTOML(await fs.readFile(sandbox.configFile, 'utf-8')) as {
        accounts: { smtp: { host: string; tls: boolean; starttls: boolean } }[];
      };
      const { host, tls, starttls } = saved.accounts[0].smtp;
      expect({ host, tls, starttls }).toEqual({ host: '127.0.0.1', tls: false, starttls: false });
    });
  });

  it('should hand the connection probe the default answers with certificate checks on', async () => {
    await (await sandbox.entryPoint('account add'))();

    expect(probes.testImap.mock.lastCall?.[0]).toEqual({
      name: 'work',
      email: 'user@example.com',
      fullName: undefined,
      username: 'user@example.com',
      password: 'app-password',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: {
        host: 'smtp.example.com',
        port: 465,
        tls: true,
        starttls: false,
        verifySsl: true,
        pool: { enabled: false, maxConnections: 1, maxMessages: 100 },
      },
    });
  });

  it('should leave the config byte-identical when the probe fails and saving anyway is declined', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL, { mode: 0o600 });
    probes.testImap.mockResolvedValueOnce({ success: false, error: 'Connection refused' });
    wizard.overrides.set('Some connections failed. Save config anyway?', false);

    await (await sandbox.entryPoint('account add'))();

    expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL);
  });

  it('should leave the config byte-identical when only the SMTP probe fails and saving anyway is declined', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL, { mode: 0o600 });
    probes.testSmtp.mockResolvedValueOnce({ success: false, error: 'Authentication failed' });
    wizard.overrides.set('Some connections failed. Save config anyway?', false);

    await (await sandbox.entryPoint('account add'))();

    expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL);
  });

  // Enter on a failed probe must not save settings that did not connect.
  it('should offer no as the default answer to saving after a failed probe', async () => {
    probes.testImap.mockResolvedValueOnce({ success: false, error: 'Connection refused' });
    wizard.overrides.set('Some connections failed. Save config anyway?', false);

    await (await sandbox.entryPoint('account add'))();

    const asked = wizard.asked.find(
      ({ message }) => message === 'Some connections failed. Save config anyway?',
    );
    expect(asked?.options.initialValue).toBe(false);
  });

  describe('with an answer other than the default at every prompt', () => {
    beforeEach(() => {
      Object.entries(CUSTOM_ANSWERS).forEach(([message, value]) => {
        wizard.overrides.set(message, value);
      });
    });

    it('should hand both probes the account those answers describe', async () => {
      await (await sandbox.entryPoint('account add'))();

      const expected = {
        name: 'work',
        email: 'user@example.com',
        fullName: 'Ada Example',
        username: 'ada.login',
        password: 'other-app-password',
        imap: { host: 'mail.example.com', port: 143, tls: false, starttls: true, verifySsl: true },
        smtp: {
          host: 'relay.example.com',
          port: 587,
          tls: false,
          starttls: true,
          verifySsl: true,
          pool: { enabled: true, maxConnections: 3, maxMessages: 50 },
        },
      };
      expect({
        imap: probes.testImap.mock.lastCall?.[0],
        smtp: probes.testSmtp.mock.lastCall?.[0],
      }).toEqual({ imap: expected, smtp: expected });
    });

    it('should save the account those answers describe, full_name included', async () => {
      await (await sandbox.entryPoint('account add'))();

      const saved = parseTOML(await fs.readFile(sandbox.configFile, 'utf-8')) as {
        accounts: unknown[];
      };
      expect(saved.accounts).toEqual([
        {
          name: 'work',
          email: 'user@example.com',
          full_name: 'Ada Example',
          username: 'ada.login',
          password: 'other-app-password',
          imap: {
            host: 'mail.example.com',
            port: 143,
            tls: false,
            starttls: true,
            verify_ssl: true,
            disable_imap4rev2: false,
          },
          smtp: {
            host: 'relay.example.com',
            port: 587,
            tls: false,
            starttls: true,
            verify_ssl: true,
            pool: { enabled: true, max_connections: 3, max_messages: 50 },
          },
        },
      ]);
    });
  });
});
