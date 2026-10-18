import fs from 'node:fs/promises';

import {
  CONFIG_WITH_PERSONAL,
  CONFIG_WITH_PERSONAL_AND_WORK,
} from '../test-support/account-config-fixtures.js';
import type { AccountCommand, Answer } from '../test-support/cli-wizard.js';
import {
  EXAMPLE_PROVIDER,
  promptPattern,
  promptRoster,
  useAccountSandbox,
} from '../test-support/cli-wizard.js';

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

interface CancelRow {
  prompt: string;
  command: AccountCommand;
  name?: string;
  config: string;
  overrides?: Record<string, Answer>;
  detect?: boolean;
  probeFails?: boolean;
}

const ADD = { command: 'account add', config: CONFIG_WITH_PERSONAL } as const;
const POOLED = {
  ...ADD,
  overrides: { 'Enable SMTP connection pooling?': true, 'SMTP pool max connections': '2' },
};
const EDIT_ONLY = {
  command: 'account edit',
  name: 'personal',
  config: CONFIG_WITH_PERSONAL,
} as const;
const PICK = { config: CONFIG_WITH_PERSONAL_AND_WORK } as const;

/** One row per prompt in account-commands.ts, each reached by the shortest flow. */
const ROWS: CancelRow[] = [
  { prompt: 'IMAP host', ...ADD },
  { prompt: 'IMAP port', ...ADD },
  { prompt: 'IMAP use TLS?', ...ADD },
  { prompt: 'SMTP host', ...ADD },
  { prompt: 'SMTP port', ...ADD },
  { prompt: 'SMTP security', ...ADD },
  { prompt: 'Enable SMTP connection pooling?', ...ADD },
  { prompt: 'SMTP pool max connections', ...POOLED },
  { prompt: 'SMTP pool max messages per connection', ...POOLED },
  { prompt: 'Account name', ...ADD },
  { prompt: 'Email address', ...ADD },
  { prompt: 'Full name (optional)', ...ADD },
  { prompt: 'Username', ...ADD },
  { prompt: 'Password / App Password', ...ADD },
  {
    prompt: 'Use detected settings?',
    ...ADD,
    overrides: { 'Email address': 'user@example.test' },
    detect: true,
  },
  { prompt: 'Some connections failed. Save config anyway?', ...ADD, probeFails: true },
  { prompt: 'Which account do you want to edit?', command: 'account edit', ...PICK },
  { prompt: 'Editing "*" — what would you like to change?', ...EDIT_ONLY },
  { prompt: 'Test connections with updated settings?', ...EDIT_ONLY },
  { prompt: 'Which account do you want to delete?', command: 'account delete', ...PICK },
  {
    prompt: 'Delete account "*" (*)? This cannot be undone.',
    command: 'account delete',
    name: 'personal',
    ...PICK,
  },
];

describe('mailoo account Ctrl-C', () => {
  const sandbox = useAccountSandbox(wizard, probes);

  // A prompt added without a row here would ship without a Ctrl-C check.
  it('should have a row for every prompt in account-commands.ts', async () => {
    const source = await fs.readFile(new URL('./account-commands.ts', import.meta.url), 'utf-8');

    expect(ROWS.map((row) => row.prompt).sort()).toEqual(promptRoster(source).sort());
  });

  it.each(ROWS)(
    'should stop at "$prompt" on Ctrl-C, resolve quietly and leave the config byte-identical',
    async ({ prompt, command, name, config, overrides = {}, detect, probeFails }) => {
      await fs.writeFile(sandbox.configFile, config, { mode: 0o600 });
      Object.entries(overrides).forEach(([message, value]) => {
        wizard.overrides.set(message, value);
      });
      if (probeFails) {
        probes.testImap.mockResolvedValueOnce({ success: false, error: 'Connection refused' });
      }
      wizard.cancelAt.add(prompt);
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const run = await sandbox.entryPoint(command, name, detect ? EXAMPLE_PROVIDER : undefined);

      const outcome = await run().then(
        () => 'resolved',
        (err: unknown) => err,
      );

      expect({
        outcome,
        lastPrompt: wizard.asked.at(-1)?.message,
        errors: stderr.mock.calls,
        config: await fs.readFile(sandbox.configFile, 'utf-8'),
      }).toEqual({
        outcome: 'resolved',
        lastPrompt: expect.stringMatching(promptPattern(prompt)),
        errors: [],
        config,
      });
    },
  );
});
