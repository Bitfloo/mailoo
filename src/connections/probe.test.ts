import type { AccountConfig } from '../types/index.js';
import { testImap, testSmtp } from './probe.js';

const h = vi.hoisted(() => ({
  connectError: null as Error | null,
  verifyError: null as Error | null,
  // Folders whose STATUS the server refuses, as for a mailbox that does not exist.
  missing: new Set<string>(),
  logout: vi.fn(async () => {}),
  close: vi.fn(),
}));

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

// A Gmail-style account: the folders hang under [Gmail]/ and their counts differ.
vi.mock('imapflow', () => ({
  ImapFlow: class {
    on(): this {
      return this;
    }

    // eslint-disable-next-line class-methods-use-this
    async connect(): Promise<void> {
      if (h.connectError) throw h.connectError;
    }

    // eslint-disable-next-line class-methods-use-this
    async list(): Promise<{ path: string }[]> {
      return [{ path: '[Gmail]/All Mail' }, { path: '[Gmail]/Sent Mail' }];
    }

    // eslint-disable-next-line class-methods-use-this
    async status(path: string): Promise<{ messages: number }> {
      if (h.missing.has(path)) {
        throw Object.assign(new Error('Command failed'), { serverResponseCode: 'NONEXISTENT' });
      }
      return { messages: path === 'INBOX' ? 12 : 1834 };
    }

    // eslint-disable-next-line class-methods-use-this
    async logout(): Promise<void> {
      await h.logout();
    }
  },
}));

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      verify: async () => {
        if (h.verifyError) throw h.verifyError;
        return true;
      },
      close: h.close,
    }),
  },
}));

const account: AccountConfig = {
  name: 'work',
  email: 'work@example.com',
  username: 'work@example.com',
  password: 'wrong-password',
  imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
};

beforeEach(() => {
  h.connectError = null;
  h.verifyError = null;
  h.missing.clear();
  h.logout.mockClear();
  h.close.mockClear();
});

describe('testImap', () => {
  it('should report the refused login and still log out', async () => {
    // imapflow's shape for a refused LOGIN: a generic message, the reason in the fields.
    h.connectError = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      serverResponseCode: 'AUTHENTICATIONFAILED',
      response: 'Invalid credentials (Failure)',
    });
    expect(await testImap(account)).toEqual({ success: false, error: 'Command failed' });
    expect(h.logout).toHaveBeenCalledOnce();
  });

  it('should log out after a successful probe', async () => {
    expect(await testImap(account)).toEqual({
      success: true,
      details: { messages: 12, folders: 2 },
    });
    expect(h.logout).toHaveBeenCalledOnce();
  });

  it('should count the first folder when the account has no INBOX', async () => {
    h.missing.add('INBOX');
    expect(await testImap(account)).toEqual({
      success: true,
      details: { messages: 1834, folders: 2 },
    });
  });
});

describe('testSmtp', () => {
  it('should close the transport after a successful verify', async () => {
    expect(await testSmtp(account)).toEqual({ success: true });
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('should report the refused login and close the transport', async () => {
    h.verifyError = Object.assign(
      new Error('Invalid login: 535-5.7.8 Username and Password not accepted'),
      { code: 'EAUTH', responseCode: 535 },
    );
    expect(await testSmtp(account)).toEqual({
      success: false,
      error: 'Invalid login: 535-5.7.8 Username and Password not accepted',
    });
    expect(h.close).toHaveBeenCalledOnce();
  });
});
