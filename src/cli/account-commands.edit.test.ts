import fs from 'node:fs/promises';

import { parse as parseTOML } from 'smol-toml';

import {
  CONFIG_WITH_PERSONAL,
  CONFIG_WITH_PERSONAL_AND_WORK,
} from '../test-support/account-config-fixtures.js';
import { EXAMPLE_PROVIDER, useAccountSandbox } from '../test-support/cli-wizard.js';

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

const EDIT_PERSONAL = 'Editing "personal" — what would you like to change?';

/** The personal account with a login name and every server setting off its default. */
const CONFIG_CUSTOM = CONFIG_WITH_PERSONAL.replace(
  'password = "secret"',
  'username = "me.login"\npassword = "secret"',
)
  .replace('host = "imap.example.com"', 'host = "imap.example.com"\nport = 143\ntls = false')
  .replace(
    'host = "smtp.example.com"',
    'host = "smtp.example.com"\nport = 587\ntls = false\nstarttls = true\n\n' +
      '[accounts.smtp.pool]\nenabled = false\nmax_connections = 4\nmax_messages = 25',
  );

const CUSTOM_IMAP = {
  host: 'imap.example.com',
  port: 143,
  tls: false,
  starttls: true,
  verify_ssl: true,
  disable_imap4rev2: false,
};
const CUSTOM_SMTP = {
  host: 'smtp.example.com',
  port: 587,
  tls: false,
  starttls: true,
  verify_ssl: true,
  pool: { enabled: false, max_connections: 4, max_messages: 25 },
};

describe('mailoo account edit', () => {
  const sandbox = useAccountSandbox(wizard, probes);

  async function savedAccounts(): Promise<Record<string, unknown>[]> {
    const saved = parseTOML(await fs.readFile(sandbox.configFile, 'utf-8')) as {
      accounts: Record<string, unknown>[];
    };
    return saved.accounts;
  }

  /** The initialValue each prompt was given, by message. */
  function offered(): Record<string, unknown> {
    return Object.fromEntries(
      wizard.asked.map(({ message, options }) => [message, options.initialValue]),
    );
  }

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

  it('should keep the login, password and server settings when only the identity is edited', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_CUSTOM, { mode: 0o600 });

    await (await sandbox.entryPoint('account edit', 'personal'))();

    expect(await savedAccounts()).toEqual([
      {
        name: 'work',
        email: 'user@example.com',
        username: 'me.login',
        password: 'secret',
        imap: CUSTOM_IMAP,
        smtp: CUSTOM_SMTP,
      },
    ]);
  });

  it('should offer the current name, address and full name when the identity is edited', async () => {
    const withFullName = CONFIG_WITH_PERSONAL.replace(
      'email = "me@example.com"',
      'email = "me@example.com"\nfull_name = "Me Example"',
    );
    await fs.writeFile(sandbox.configFile, withFullName, { mode: 0o600 });

    await (await sandbox.entryPoint('account edit', 'personal'))();

    const {
      'Account name': name,
      'Email address': email,
      'Full name (optional)': full,
    } = offered();
    expect({ name, email, full }).toEqual({
      name: 'personal',
      email: 'me@example.com',
      full: 'Me Example',
    });
  });

  it.each([
    ['starttls', 'tls = false\nstarttls = true'],
    ['none', 'tls = false\nstarttls = false'],
    ['tls', 'tls = true\nstarttls = false'],
  ])(
    'should offer SMTP security %s for an account whose SMTP is set up that way',
    async (security, flags) => {
      const smtp = 'host = "smtp.example.com"';
      const config = CONFIG_WITH_PERSONAL.replace(smtp, `${smtp}\n${flags}`);
      await fs.writeFile(sandbox.configFile, config, { mode: 0o600 });
      wizard.overrides.set(EDIT_PERSONAL, 'servers');

      await (await sandbox.entryPoint('account edit', 'personal'))();

      expect(offered()['SMTP security']).toBe(security);
    },
  );

  it('should leave the config byte-identical when the account to edit does not exist', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL_AND_WORK, { mode: 0o600 });

    await (await sandbox.entryPoint('account edit', 'nobody'))();

    expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL_AND_WORK);
  });

  it('should offer the current server settings when the servers are edited', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_CUSTOM, { mode: 0o600 });
    wizard.overrides.set(EDIT_PERSONAL, 'servers');
    wizard.overrides.set('Enable SMTP connection pooling?', true);
    wizard.overrides.set('SMTP pool max connections', '4');
    wizard.overrides.set('SMTP pool max messages per connection', '25');

    await (await sandbox.entryPoint('account edit', 'personal'))();

    expect(offered()).toEqual({
      [EDIT_PERSONAL]: undefined,
      'IMAP host': 'imap.example.com',
      'IMAP port': '143',
      'IMAP use TLS?': false,
      'SMTP host': 'smtp.example.com',
      'SMTP port': '587',
      'SMTP security': 'starttls',
      'Enable SMTP connection pooling?': false,
      'SMTP pool max connections': '4',
      'SMTP pool max messages per connection': '25',
      'Test connections with updated settings?': true,
    });
  });

  it('should save the new server settings and keep the rest when the servers are edited', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_CUSTOM, { mode: 0o600 });
    wizard.overrides.set(EDIT_PERSONAL, 'servers');

    await (await sandbox.entryPoint('account edit', 'personal'))();

    expect(await savedAccounts()).toEqual([
      {
        name: 'personal',
        email: 'me@example.com',
        username: 'me.login',
        password: 'secret',
        imap: { ...CUSTOM_IMAP, port: 993, tls: true, starttls: false },
        smtp: { ...CUSTOM_SMTP, port: 465, tls: true, starttls: false },
      },
    ]);
  });

  it('should offer the current login when the credentials are edited', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_CUSTOM, { mode: 0o600 });
    wizard.overrides.set(EDIT_PERSONAL, 'credentials');

    await (await sandbox.entryPoint('account edit', 'personal'))();

    expect(offered().Username).toBe('me.login');
  });

  it('should save the new credentials and keep the rest when the credentials are edited', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_CUSTOM, { mode: 0o600 });
    wizard.overrides.set(EDIT_PERSONAL, 'credentials');

    await (await sandbox.entryPoint('account edit', 'personal'))();

    expect(await savedAccounts()).toEqual([
      {
        name: 'personal',
        email: 'me@example.com',
        username: 'user@example.com',
        password: 'app-password',
        imap: CUSTOM_IMAP,
        smtp: CUSTOM_SMTP,
      },
    ]);
  });

  it('should edit the only account without asking which one', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL, { mode: 0o600 });

    await (await sandbox.entryPoint('account edit'))();

    expect({
      asked: wizard.asked.some(({ message }) => message === 'Which account do you want to edit?'),
      names: (await savedAccounts()).map(({ name }) => name),
    }).toEqual({ asked: false, names: ['work'] });
  });

  it('should edit the account picked from the list when no name is given', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL_AND_WORK, { mode: 0o600 });
    wizard.overrides.set('Which account do you want to edit?', 1);
    wizard.overrides.set('Editing "work" — what would you like to change?', 'identity');

    await (await sandbox.entryPoint('account edit'))();

    expect((await savedAccounts()).map(({ name, email }) => `${name} ${email}`)).toEqual([
      'personal me@example.com',
      'work user@example.com',
    ]);
  });

  it('should leave the config byte-identical when the edit probe fails and saving anyway is declined', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL, { mode: 0o600 });
    wizard.overrides.set('Test connections with updated settings?', true);
    wizard.overrides.set('Some connections failed. Save config anyway?', false);
    probes.testImap.mockResolvedValueOnce({ success: false, error: 'Connection refused' });

    await (await sandbox.entryPoint('account edit', 'personal'))();

    expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL);
  });

  describe('of everything, with a provider detected for the new address', () => {
    beforeEach(async () => {
      await fs.writeFile(sandbox.configFile, CONFIG_CUSTOM, { mode: 0o600 });
      wizard.overrides.set(EDIT_PERSONAL, 'all');
      wizard.overrides.set('Email address', 'user@example.test');
    });

    it('should save the detected settings without asking for servers when they are accepted', async () => {
      wizard.overrides.set('Use detected settings?', true);

      await (await sandbox.entryPoint('account edit', 'personal', EXAMPLE_PROVIDER))();

      const [saved] = await savedAccounts();
      expect({
        servers: { imap: saved?.imap, smtp: saved?.smtp },
        askedForServers: wizard.asked.some(({ message }) => message === 'IMAP host'),
      }).toEqual({
        servers: {
          imap: {
            ...CUSTOM_IMAP,
            host: 'imap.example.test',
            port: 993,
            tls: true,
            starttls: false,
          },
          smtp: {
            ...CUSTOM_SMTP,
            host: 'smtp.example.test',
            pool: { enabled: true, max_connections: 1, max_messages: 100 },
          },
        },
        askedForServers: false,
      });
    });

    it('should offer the current server settings when the detected ones are declined', async () => {
      wizard.overrides.set('Use detected settings?', false);

      await (await sandbox.entryPoint('account edit', 'personal', EXAMPLE_PROVIDER))();

      expect([offered()['IMAP port'], offered()['SMTP security']]).toEqual(['143', 'starttls']);
    });
  });
});
