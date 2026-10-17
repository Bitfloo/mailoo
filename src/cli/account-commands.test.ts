import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseTOML } from 'smol-toml';

import { SettingsSchema } from '../config/schema.js';

/** Wizard answers keyed by prompt message; the account uses reserved example domains. */
const ANSWERS: Record<string, string | boolean> = {
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
};

function answer({ message }: { message: string }): string | boolean {
  const value = ANSWERS[message];
  if (value === undefined) throw new Error(`unexpected prompt: ${message}`);
  return value;
}

// The terminal UI and the network probe are the only boundaries replaced.
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: () => false,
  text: vi.fn(async (options: { message: string }) => answer(options)),
  password: vi.fn(async (options: { message: string }) => answer(options)),
  confirm: vi.fn(async (options: { message: string }) => answer(options)),
  select: vi.fn(async (options: { message: string }) => answer(options)),
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { info: vi.fn(), warn: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock('../connections/manager.js', () => ({
  default: {
    testImap: async () => ({ success: true, details: { messages: 0, folders: 1 } }),
    testSmtp: async () => ({ success: true }),
  },
}));

/** Real shape: one account, then a table header the user left unclosed. */
const CONFIG_WITH_SYNTAX_ERROR = `[[accounts]]
name = "personal"
email = "me@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp
host = "smtp.example.com"
`;

/** Real shape: a config account add wrote, with one setting changed by hand. */
const CONFIG_WITH_PERSONAL = `[settings]
rate_limit = 3

[[accounts]]
name = "personal"
email = "me@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

/** Parses as TOML, fails the schema: the account email is not an address. */
const CONFIG_FAILING_SCHEMA = CONFIG_WITH_PERSONAL.replace('me@example.com', 'nope');

describe('mailoo account add and setup', () => {
  let home: string;
  let configFile: string;
  let ttyDescriptor: PropertyDescriptor | undefined;

  /** CONFIG_FILE is fixed when xdg.ts loads, so each test imports a fresh copy. */
  async function entryPoint(command: 'setup' | 'account add'): Promise<() => Promise<void>> {
    vi.stubEnv('XDG_CONFIG_HOME', home);
    vi.resetModules();
    if (command === 'setup') return (await import('./setup.js')).default;
    const runAccountCommand = (await import('./account-commands.js')).default;
    return async () => runAccountCommand('add');
  }

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-account-'));
    await fs.mkdir(path.join(home, 'mailoo'), { mode: 0o700 });
    configFile = path.join(home, 'mailoo', 'config.toml');
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(async () => {
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  // The wizard read an unparseable file as "no config" and saved a new one
  // over it, which dropped every account the file held.
  it.each(['setup', 'account add'] as const)(
    'should reject with the TOML error when mailoo %s meets a config that is not valid TOML',
    async (command) => {
      await fs.writeFile(configFile, CONFIG_WITH_SYNTAX_ERROR, { mode: 0o600 });
      const run = await entryPoint(command);

      await expect(run()).rejects.toThrow(`Config file ${configFile} is not valid TOML`);
    },
  );

  it.each(['setup', 'account add'] as const)(
    'should leave a config that is not valid TOML byte-identical when mailoo %s stops',
    async (command) => {
      await fs.writeFile(configFile, CONFIG_WITH_SYNTAX_ERROR, { mode: 0o600 });
      const run = await entryPoint(command);

      await run().catch(() => undefined);

      expect(await fs.readFile(configFile, 'utf-8')).toBe(CONFIG_WITH_SYNTAX_ERROR);
    },
  );

  it.each(['setup', 'account add'] as const)(
    'should reject with the schema error when mailoo %s meets a config that parses but is not valid',
    async (command) => {
      await fs.writeFile(configFile, CONFIG_FAILING_SCHEMA, { mode: 0o600 });
      const run = await entryPoint(command);

      await expect(run()).rejects.toThrow('Invalid email address');
    },
  );

  it.each(['setup', 'account add'] as const)(
    'should leave a config that parses but is not valid byte-identical when mailoo %s stops',
    async (command) => {
      await fs.writeFile(configFile, CONFIG_FAILING_SCHEMA, { mode: 0o600 });
      const run = await entryPoint(command);

      await run().catch(() => undefined);

      expect(await fs.readFile(configFile, 'utf-8')).toBe(CONFIG_FAILING_SCHEMA);
    },
  );

  it.each(['setup', 'account add'] as const)(
    'should leave the config byte-identical when mailoo %s meets an account name that already exists',
    async (command) => {
      const existing = CONFIG_WITH_PERSONAL.replace('"personal"', '"work"');
      await fs.writeFile(configFile, existing, { mode: 0o600 });
      const run = await entryPoint(command);

      await run();

      expect(await fs.readFile(configFile, 'utf-8')).toBe(existing);
    },
  );

  it('should append the new account and keep the existing accounts and settings when a valid config exists', async () => {
    await fs.writeFile(configFile, CONFIG_WITH_PERSONAL, { mode: 0o600 });
    const run = await entryPoint('account add');

    await run();

    const saved = parseTOML(await fs.readFile(configFile, 'utf-8')) as {
      settings: { rate_limit: number };
      accounts: { name: string }[];
    };
    expect({
      rateLimit: saved.settings.rate_limit,
      names: saved.accounts.map((a) => a.name),
    }).toEqual({ rateLimit: 3, names: ['personal', 'work'] });
  });

  it('should write a new config with the schema settings when no config file exists', async () => {
    const run = await entryPoint('account add');

    await run();

    const saved = parseTOML(await fs.readFile(configFile, 'utf-8')) as {
      settings: unknown;
      accounts: { name: string }[];
    };
    expect({ settings: saved.settings, names: saved.accounts.map((a) => a.name) }).toEqual({
      settings: SettingsSchema.parse({}),
      names: ['work'],
    });
  });
});
