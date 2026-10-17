import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';

import runAccountCommand from './account-commands.js';

// Answers by prompt message, as a user types them into `mailoo account add` for a domain
// the wizard cannot detect, so it asks for every server setting.
const answers: Record<string, string | boolean> = {
  'Account name': 'personal',
  'Email address': 'me@example.com',
  'Full name (optional)': '',
  'IMAP host': 'imap.example.com',
  'IMAP port': '993',
  'IMAP use TLS?': true,
  'SMTP host': 'smtp.example.com',
  'SMTP port': '465',
  'SMTP security': 'tls',
  'Enable SMTP connection pooling?': false,
  Username: 'me@example.com',
  'Password / App Password': 'app-password',
};
const SAVE_ANYWAY = 'Some connections failed. Save config anyway?';

const h = vi.hoisted(() => ({
  // What the connection check's spinner settles on, in order.
  checked: [] as string[],
  imapRefusal: null as Error | null,
  smtpRefusal: null as Error | null,
}));

// The config file path is fixed when the config module loads, so the directory is pinned
// before the imports run; the wizard must not find the developer's own config.
const configHome = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'mailoo-account-test-'));
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  return dir;
});

vi.mock('@clack/prompts', () => {
  const answer = async ({ message }: { message: string }): Promise<unknown> => {
    if (!(message in answers)) throw new Error(`unexpected prompt: ${message}`);
    return answers[message];
  };
  return {
    cancel: () => {},
    confirm: answer,
    intro: () => {},
    isCancel: (value: unknown) => typeof value === 'symbol',
    log: { error: () => {}, info: () => {}, success: () => {}, warning: () => {} },
    note: () => {},
    outro: () => {},
    password: answer,
    select: answer,
    spinner: () => ({
      start: () => {},
      stop: (message: string) => {
        h.checked.push(message);
      },
    }),
    text: answer,
  };
});

// Stdin is not a terminal under the runner; the guard's own behaviour is not under test here.
vi.mock('./guard.js', () => ({ default: () => {} }));

vi.mock('imapflow', () => ({
  ImapFlow: class {
    on(): this {
      return this;
    }

    // eslint-disable-next-line class-methods-use-this
    async connect(): Promise<void> {
      if (h.imapRefusal) throw h.imapRefusal;
    }

    // eslint-disable-next-line class-methods-use-this
    async list(): Promise<{ path: string }[]> {
      return [{ path: 'INBOX' }, { path: 'Sent' }];
    }

    // eslint-disable-next-line class-methods-use-this
    async status(): Promise<{ messages: number }> {
      return { messages: 3 };
    }

    // eslint-disable-next-line class-methods-use-this
    async logout(): Promise<void> {}
  },
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      verify: async () => {
        if (h.smtpRefusal) throw h.smtpRefusal;
        return true;
      },
      close: () => {},
    }),
  },
}));

const configFile = join(configHome, 'mailoo', 'config.toml');

// Node's message for a refused TCP connect; 192.0.2.0/24 is reserved for documentation.
function refused(port: number): Error {
  return Object.assign(new Error(`connect ECONNREFUSED 192.0.2.10:${port}`), {
    code: 'ECONNREFUSED',
  });
}

beforeEach(async () => {
  h.checked.length = 0;
  h.imapRefusal = null;
  h.smtpRefusal = null;
  answers[SAVE_ANYWAY] = false;
  // A saved account would make the next run stop at its duplicate name.
  await rm(join(configHome, 'mailoo'), { recursive: true, force: true });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(configHome, { recursive: true, force: true });
});

describe('mailoo account add connection check', () => {
  // An IMAP success and an SMTP refusal: neither line can come from a probe that did not run.
  it('should report the IMAP probe result and then the SMTP probe result', async () => {
    h.smtpRefusal = refused(465);
    await runAccountCommand('add');
    expect(h.checked).toEqual([
      'IMAP ✓ imap.example.com:993 — 3 messages, 2 folders',
      'SMTP ✗ connect ECONNREFUSED 192.0.2.10:465',
    ]);
  });

  it('should report a refused IMAP login with its error', async () => {
    h.imapRefusal = refused(993);
    await runAccountCommand('add');
    expect(h.checked).toContain('IMAP ✗ connect ECONNREFUSED 192.0.2.10:993');
  });
});

describe('mailoo account add after a refused probe', () => {
  it('should not save the account when the user declines', async () => {
    h.smtpRefusal = refused(465);
    await runAccountCommand('add');
    await expect(access(configFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should save the account when the user accepts', async () => {
    h.smtpRefusal = refused(465);
    answers[SAVE_ANYWAY] = true;
    await runAccountCommand('add');
    await expect(access(configFile)).resolves.toBeUndefined();
  });
});
