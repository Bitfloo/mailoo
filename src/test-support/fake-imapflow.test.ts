import { ImapFlow } from 'imapflow';

import { FakeImapFlow, fake, resetFakeServer } from './fake-imapflow.js';

interface CloseCase {
  when: string;
  port: number;
  secure?: boolean;
  code: string;
}

// Ports chosen against each half of the rule: `secure` wins when set, port 993 only when unset.
const cases: CloseCase[] = [
  { when: 'secure is true on port 143', port: 143, secure: true, code: 'ClosedAfterConnectTLS' },
  { when: 'secure is false on port 993', port: 993, secure: false, code: 'ClosedAfterConnectText' },
  { when: 'secure is unset on port 993', port: 993, code: 'ClosedAfterConnectTLS' },
];

function options({ port, secure }: CloseCase) {
  return {
    host: 'imap.example.com',
    port,
    ...(secure === undefined ? {} : { secure }),
    auth: { user: 'test@example.com', pass: 'app-password' },
    logger: false as const,
  };
}

beforeEach(resetFakeServer);

describe('FakeImapFlow close during connect', () => {
  it.each(cases)('should reject the pending connect with $code when $when', async (closeCase) => {
    fake.loginPending = new Promise(() => {});
    const client = new FakeImapFlow(options(closeCase));
    const connecting = client.connect();
    client.close();
    await expect(connecting).rejects.toMatchObject({ code: closeCase.code });
  });

  // The fake stands in for imapflow, so its socket type must follow the library's own rule.
  it.each(cases)('should count the socket as imapflow does when $when', (closeCase) => {
    const { secureConnection } = new ImapFlow(options(closeCase));
    expect(secureConnection).toBe(closeCase.code.endsWith('TLS'));
  });
});
