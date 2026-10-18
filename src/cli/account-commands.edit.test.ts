import fs from 'node:fs/promises';

import { parse as parseTOML } from 'smol-toml';

import { CONFIG_WITH_PERSONAL_AND_WORK } from '../test-support/account-config-fixtures.js';
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

describe('mailoo account edit', () => {
  const sandbox = useAccountSandbox(wizard, probes);

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
