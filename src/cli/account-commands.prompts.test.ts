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
vi.mock('../connections/probe.js', () => probes);

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

const POSITIVE = 'Must be a positive integer';

describe('mailoo account prompt validation', () => {
  const sandbox = useAccountSandbox(wizard, probes);

  // Clack shows the returned text and asks again; undefined accepts the value.
  // Enter on an untouched prompt hands the validator undefined, not ''.
  it.each([
    ['Account name', undefined, 'Account name is required'],
    ['Account name', '', 'Account name is required'],
    ['Account name', 'work', undefined],
    ['Email address', undefined, 'Please enter a valid email address'],
    ['Email address', 'user.example.com', 'Please enter a valid email address'],
    ['Email address', 'user@example.com', undefined],
    ['IMAP host', undefined, 'IMAP host is required'],
    ['IMAP host', '', 'IMAP host is required'],
    ['IMAP host', '   ', 'IMAP host is required'],
    ['IMAP host', 'imap.example.com', undefined],
    ['SMTP host', undefined, 'SMTP host is required'],
    ['SMTP host', '', 'SMTP host is required'],
    ['SMTP host', '   ', 'SMTP host is required'],
    ['SMTP host', 'smtp.example.com', undefined],
    ['SMTP pool max connections', undefined, POSITIVE],
    ['SMTP pool max connections', '', POSITIVE],
    ['SMTP pool max connections', '0', POSITIVE],
    ['SMTP pool max connections', 'many', POSITIVE],
    ['SMTP pool max connections', '1', undefined],
    ['SMTP pool max messages per connection', undefined, POSITIVE],
    ['SMTP pool max messages per connection', '', POSITIVE],
    ['SMTP pool max messages per connection', '0', POSITIVE],
    ['SMTP pool max messages per connection', 'many', POSITIVE],
    ['SMTP pool max messages per connection', '1', undefined],
    ['Password / App Password', undefined, 'Password is required'],
    ['Password / App Password', '', 'Password is required'],
    ['Password / App Password', 'app-password', undefined],
  ])('should have the "%s" validator turn %j into %j', async (prompt, input, expected) => {
    wizard.overrides.set('Enable SMTP connection pooling?', true);
    wizard.overrides.set('SMTP pool max connections', '2');
    wizard.overrides.set('SMTP pool max messages per connection', '2');

    await (await sandbox.entryPoint('account add'))();

    const asked = wizard.asked.find(({ message }) => message === prompt);
    const validate = asked?.options.validate as (value?: string) => string | undefined;
    expect(validate(input)).toBe(expected);
  });
});
