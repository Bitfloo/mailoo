import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseTOML } from 'smol-toml';

import { SettingsSchema } from '../config/schema.js';
import {
  CONFIG_FAILING_SCHEMA,
  CONFIG_WITH_PERSONAL,
  CONFIG_WITH_PERSONAL_AND_WORK,
  CONFIG_WITH_SYNTAX_ERROR,
} from '../test-support/account-config-fixtures.js';

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
  'Editing "personal" — what would you like to change?': 'identity',
  'Test connections with updated settings?': false,
  'Delete account "personal" (me@example.com)? This cannot be undone.': true,
};

/** Answers one test sets in place of the ones above; cleared after each test. */
const OVERRIDES = new Map<string, string | boolean | symbol>();

function answer({ message }: { message: string }): string | boolean | symbol {
  const value = OVERRIDES.get(message) ?? ANSWERS[message];
  if (value === undefined) throw new Error(`unexpected prompt: ${message}`);
  return value;
}

// The terminal UI and the network probe are the only boundaries replaced.
// Clack reports Ctrl-C as a symbol, which isCancel recognises.
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
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

describe('mailoo account and setup', () => {
  let home: string;
  let configFile: string;
  let ttyDescriptor: PropertyDescriptor | undefined;

  /** CONFIG_FILE is fixed when xdg.ts loads, so each test imports a fresh copy. */
  async function entryPoint(
    command: 'setup' | 'account add' | 'account edit' | 'account delete' | 'account list',
    name?: string,
  ): Promise<() => Promise<void>> {
    vi.stubEnv('XDG_CONFIG_HOME', home);
    vi.resetModules();
    if (command === 'setup') return (await import('./setup.js')).default;
    const runAccountCommand = (await import('./account-commands.js')).default;
    return async () => runAccountCommand(command.slice('account '.length), name);
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
    OVERRIDES.clear();
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

    const saved = parseTOML(await fs.readFile(configFile, 'utf-8'));
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
    const run = await entryPoint('setup');

    await run();

    const saved = parseTOML(await fs.readFile(configFile, 'utf-8')) as {
      accounts: { name: string }[];
    };
    expect(saved.accounts.map((a) => a.name)).toEqual(['work']);
  });

  it.each([
    ['IMAP use TLS?', false, 'imap', { tls: false, starttls: true }],
    ['SMTP security', 'starttls', 'smtp', { tls: false, starttls: true }],
    ['SMTP security', 'none', 'smtp', { tls: false, starttls: false }],
  ] as const)('should write the %s answer %s as %s %o', async (prompt, value, side, flags) => {
    OVERRIDES.set(prompt, value);
    const run = await entryPoint('account add');

    await run();

    const saved = parseTOML(await fs.readFile(configFile, 'utf-8')) as {
      accounts: Record<'imap' | 'smtp', { tls: boolean; starttls: boolean }>[];
    };
    const { tls, starttls } = saved.accounts[0][side];
    expect({ tls, starttls }).toEqual(flags);
  });

  it('should refuse to delete the last account and leave the config byte-identical', async () => {
    await fs.writeFile(configFile, CONFIG_WITH_PERSONAL, { mode: 0o600 });
    const run = await entryPoint('account delete', 'personal');

    await run();

    expect(await fs.readFile(configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL);
  });

  it('should remove only the named account and keep the other when delete is confirmed', async () => {
    await fs.writeFile(configFile, CONFIG_WITH_PERSONAL_AND_WORK, { mode: 0o600 });
    const run = await entryPoint('account delete', 'personal');

    await run();

    const saved = parseTOML(await fs.readFile(configFile, 'utf-8')) as {
      accounts: { name: string }[];
    };
    expect(saved.accounts.map((a) => a.name)).toEqual(['work']);
  });

  it.each([
    ['declined', false],
    ['cancelled with Ctrl-C', Symbol('clack:cancel')],
  ])('should keep both accounts byte-identical when delete is %s', async (_, reply) => {
    await fs.writeFile(configFile, CONFIG_WITH_PERSONAL_AND_WORK, { mode: 0o600 });
    OVERRIDES.set('Delete account "personal" (me@example.com)? This cannot be undone.', reply);
    const run = await entryPoint('account delete', 'personal');

    await run();

    expect(await fs.readFile(configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL_AND_WORK);
  });

  it('should list an account with TLS for IMAP and STARTTLS for SMTP when it is set up that way', async () => {
    const smtp = 'host = "smtp.example.com"';
    const config = CONFIG_WITH_PERSONAL.replace(
      smtp,
      `${smtp}\nport = 587\ntls = false\nstarttls = true`,
    );
    await fs.writeFile(configFile, config, { mode: 0o600 });
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await (await entryPoint('account list'))();

    expect(stdout.mock.calls.flat().join('\n')).toMatch(
      /imap\.example\.com:993 \(TLS\) +smtp\.example\.com:587 \(STARTTLS\)/,
    );
    stdout.mockRestore();
  });

  it("should refuse an edit that renames an account to another account's name", async () => {
    await fs.writeFile(configFile, CONFIG_WITH_PERSONAL_AND_WORK, { mode: 0o600 });
    const run = await entryPoint('account edit', 'personal');

    await run();

    expect(await fs.readFile(configFile, 'utf-8')).toBe(CONFIG_WITH_PERSONAL_AND_WORK);
  });
});
