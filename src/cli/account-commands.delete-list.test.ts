import fs from 'node:fs/promises';

import { parse as parseTOML } from 'smol-toml';

import {
  CONFIG_WITH_PERSONAL,
  CONFIG_WITH_PERSONAL_AND_WORK,
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

describe('mailoo account delete and list', () => {
  const sandbox = useAccountSandbox(wizard, probes);

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

  it('should delete the account picked from the list when no name is given', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL_AND_WORK, { mode: 0o600 });
    wizard.overrides.set('Which account do you want to delete?', 1);
    wizard.overrides.set('Delete account "work" (work@example.com)? This cannot be undone.', true);

    await (await sandbox.entryPoint('account delete'))();

    const saved = parseTOML(await fs.readFile(sandbox.configFile, 'utf-8')) as {
      accounts: { name: string }[];
    };
    expect(saved.accounts.map((a) => a.name)).toEqual(['personal']);
  });

  it('should leave the config byte-identical when the account to delete does not exist', async () => {
    await fs.writeFile(sandbox.configFile, CONFIG_WITH_PERSONAL_AND_WORK, { mode: 0o600 });

    await (await sandbox.entryPoint('account delete', 'nobody'))();

    expect(await fs.readFile(sandbox.configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL_AND_WORK);
  });

  it('should list an account with neither TLS nor STARTTLS as plain', async () => {
    const imap = 'host = "imap.example.com"';
    const config = CONFIG_WITH_PERSONAL.replace(imap, `${imap}\ntls = false\nstarttls = false`);
    await fs.writeFile(sandbox.configFile, config, { mode: 0o600 });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await (await sandbox.entryPoint('account list'))();

    expect(stdout.mock.calls.flat().join('\n')).toMatch(/imap\.example\.com:993 \(plain\)/);
  });

  it('should point to account add when list finds no config file', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await (await sandbox.entryPoint('account list'))();

    expect(stderr.mock.calls.flat()).toEqual([
      `No config file found at: ${sandbox.configFile}`,
      "Run 'mailoo account add' to create one.",
    ]);
  });

  // The schema refuses an empty account list before list could report one.
  it('should reject a config with no accounts with the schema error', async () => {
    await fs.writeFile(sandbox.configFile, 'accounts = []\n', { mode: 0o600 });

    await expect((await sandbox.entryPoint('account list'))()).rejects.toThrow(
      'At least one account is required',
    );
  });
});
