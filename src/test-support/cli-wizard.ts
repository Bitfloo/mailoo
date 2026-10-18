/**
 * What the CLI wizard suites share: a stand-in for @clack/prompts that answers
 * each prompt by its message and records what it asked, the add wizard's
 * answers, a temp config home per test, and the prompt roster of a source file.
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
import type { ProviderConfig } from '../types/index.js';

export type Answer = string | boolean | symbol | string[];

export interface AskedPrompt {
  message: string;
  options: Record<string, unknown>;
}

export interface WizardState {
  /** Answers one test sets in place of the suite's own. */
  overrides: Map<string, Answer>;
  asked: AskedPrompt[];
  /** promptPattern templates; a prompt one of them matches is answered with Ctrl-C. */
  cancelAt: Set<string>;
}

export interface Probes {
  testImap: Mock<typeof ConnectionManager.testImap>;
  testSmtp: Mock<typeof ConnectionManager.testSmtp>;
}

export function newWizardState(): WizardState {
  return { overrides: new Map(), asked: [], cancelAt: new Set() };
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

/** Clack reports Ctrl-C as a unique symbol; the stand-in's isCancel accepts any symbol. */
export const CTRL_C = Symbol('clack:cancel');

/** A provider for a reserved test domain, so detection runs without naming a real one. */
export const EXAMPLE_PROVIDER: ProviderConfig = {
  name: 'Example Mail',
  domains: ['example.test'],
  imap: { host: 'imap.example.test', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.test', port: 587, tls: false, starttls: true, verifySsl: true },
};

/** A prompt message template with each `${…}` written as `*`, as a whole-message match. */
export function promptPattern(template: string): RegExp {
  const parts = template.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('.*')}$`);
}

/** Every clack prompt message in a source file, as promptPattern templates. */
export function promptRoster(source: string): string[] {
  const call =
    /\b(?:text|confirm|select|multiselect|p_password)(?:<\w+>)?\(\{\s*message:\s*(?:'([^']*)'|`([^`]*)`)/g;
  return [...source.matchAll(call)].map(
    ([, quoted, template]) => quoted ?? template.replace(/\$\{[^}]*\}/g, '*'),
  );
}

export function clackPromptsMock(
  state: WizardState,
  answers: Readonly<Record<string, Answer>>,
): Record<string, unknown> {
  const prompt = vi.fn(async (options: { message: string }) => {
    state.asked.push({ message: options.message, options });
    if ([...state.cancelAt].some((template) => promptPattern(template).test(options.message))) {
      return CTRL_C;
    }
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
  entryPoint: (
    command: AccountCommand,
    name?: string,
    provider?: ProviderConfig,
  ) => Promise<() => Promise<void>>;
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
    state.asked.splice(0);
    state.cancelAt.clear();
    probes.testImap.mockReset();
    probes.testSmtp.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  return {
    get configFile() {
      return path.join(home, 'mailoo', 'config.toml');
    },
    async entryPoint(command, name, provider) {
      vi.stubEnv('XDG_CONFIG_HOME', home);
      vi.resetModules();
      if (provider) (await import('../cli/providers.js')).PROVIDERS.push(provider);
      if (command === 'setup') return (await import('../cli/setup.js')).default;
      const runAccountCommand = (await import('../cli/account-commands.js')).default;
      return async () => runAccountCommand(command.slice('account '.length), name);
    },
  };
}
