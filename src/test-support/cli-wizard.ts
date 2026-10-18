/**
 * What the CLI wizard suites share: a stand-in for @clack/prompts that answers
 * each prompt by its message, the add wizard's answers, and a temp config home
 * per test.
 *
 * A suite creates its state and probes in vi.hoisted and passes them in:
 * entryPoint resets the module registry, and state kept in this module would
 * be lost with it.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Mock } from 'vitest';

import type ConnectionManager from '../connections/manager.js';

export type Answer = string | boolean | symbol | string[];

export interface WizardState {
  /** Answers one test sets in place of the suite's own. */
  overrides: Map<string, Answer>;
}

export interface Probes {
  testImap: Mock<typeof ConnectionManager.testImap>;
  testSmtp: Mock<typeof ConnectionManager.testSmtp>;
}

export function newWizardState(): WizardState {
  return { overrides: new Map() };
}

export function newProbes(): Probes {
  return {
    testImap: vi.fn<typeof ConnectionManager.testImap>(),
    testSmtp: vi.fn<typeof ConnectionManager.testSmtp>(),
  };
}

/** Add wizard answers keyed by prompt message; the account uses reserved example domains. */
export const ACCOUNT_ANSWERS: Readonly<Record<string, Answer>> = {
  'Account name': 'work',
  'Email address': 'user@example.com',
  'Full name (optional)': '',
  'IMAP host': 'imap.example.com',
  'IMAP port': '993',
  'IMAP use TLS?': true,
  'SMTP host': 'smtp.example.com',
  'SMTP port': '465',
  'SMTP security': 'tls',
  'Enable SMTP connection pooling?': false,
  Username: 'user@example.com',
  'Password / App Password': 'app-password',
  'Editing "personal" — what would you like to change?': 'identity',
  'Test connections with updated settings?': false,
  'Delete account "personal" (me@example.com)? This cannot be undone.': true,
};

/** Clack reports Ctrl-C as a symbol, which isCancel recognises. */
export function clackPromptsMock(
  state: WizardState,
  answers: Readonly<Record<string, Answer>>,
): Record<string, unknown> {
  const prompt = vi.fn(async (options: { message: string }) => {
    const value = state.overrides.get(options.message) ?? answers[options.message];
    if (value === undefined) throw new Error(`unexpected prompt: ${options.message}`);
    return value;
  });
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    cancel: vi.fn(),
    isCancel: (value: unknown) => typeof value === 'symbol',
    text: prompt,
    password: prompt,
    confirm: prompt,
    select: prompt,
    spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
    log: { info: vi.fn(), warn: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() },
  };
}

export type AccountCommand =
  | 'setup'
  | 'account add'
  | 'account edit'
  | 'account delete'
  | 'account list';

export interface AccountSandbox {
  readonly configFile: string;
  /** CONFIG_FILE is fixed when xdg.ts loads, so each run imports a fresh copy. */
  entryPoint: (command: AccountCommand, name?: string) => Promise<() => Promise<void>>;
}

/**
 * A temp XDG config home with an empty mailoo directory, a TTY on stdin, and
 * probes that pass unless a test says otherwise.
 */
export function useAccountSandbox(state: WizardState, probes: Probes): AccountSandbox {
  let home = '';
  let ttyDescriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-account-'));
    await fs.mkdir(path.join(home, 'mailoo'), { mode: 0o700 });
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    probes.testImap.mockImplementation(async () => ({
      success: true,
      details: { messages: 0, folders: 1 },
    }));
    probes.testSmtp.mockImplementation(async () => ({ success: true }));
  });

  afterEach(async () => {
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    state.overrides.clear();
    probes.testImap.mockReset();
    probes.testSmtp.mockReset();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  return {
    get configFile() {
      return path.join(home, 'mailoo', 'config.toml');
    },
    async entryPoint(command, name) {
      vi.stubEnv('XDG_CONFIG_HOME', home);
      vi.resetModules();
      if (command === 'setup') return (await import('../cli/setup.js')).default;
      const runAccountCommand = (await import('../cli/account-commands.js')).default;
      return async () => runAccountCommand(command.slice('account '.length), name);
    },
  };
}
