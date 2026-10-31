/* eslint-disable max-classes-per-file -- Distinct raw/TLS sockets exercise the authentication TLS gate. */

import type { AccountConfig } from '../types/index.js';

// The socket boundary is controlled so TCP fragmentation and EOF ordering are deterministic.
const wire = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  const state = {
    sockets: [] as FakeSocket[],
    commands: [] as string[],
    response: [] as Buffer[],
    authRefusal: '',
    greetingEof: false,
    literalEof: false,
    handshakeFailure: '',
    onHandshake: () => {},
  };
  class FakeSocket extends EventEmitter {
    destroyed = false;
    readableEnded = false;
    idleMs = 0;
    idleTimer: ReturnType<typeof setTimeout> | undefined;

    setTimeout(ms: number): this {
      this.idleMs = ms;
      this.refreshIdle();
      return this;
    }

    refreshIdle(): void {
      clearTimeout(this.idleTimer);
      if (this.idleMs > 0 && !this.destroyed) {
        this.idleTimer = setTimeout(() => this.emit('timeout'), this.idleMs);
      }
    }

    deliver(chunks: Buffer[], eof = false): void {
      chunks.forEach((chunk) => {
        setImmediate(() => {
          this.refreshIdle();
          this.emit('data', chunk);
        });
      });
      if (eof) {
        setImmediate(() => {
          this.readableEnded = true;
          this.emit('end');
          this.destroy();
        });
      }
    }

    write(chunk: string): boolean {
      this.refreshIdle();
      state.commands.push(chunk);
      if (chunk.startsWith('STARTTLS')) this.deliver([Buffer.from('OK "upgrade"\r\n')]);
      else if (chunk.startsWith('AUTHENTICATE')) {
        this.deliver([Buffer.from(state.authRefusal || 'OK "authenticated"\r\n')]);
      } else this.deliver(state.response, state.literalEof);
      return true;
    }

    destroy(): this {
      if (!this.destroyed) {
        this.destroyed = true;
        clearTimeout(this.idleTimer);
        setImmediate(() => this.emit('close'));
      }
      return this;
    }
  }
  class FakeTlsSocket extends FakeSocket {
    encrypted = true;

    constructor(readonly raw: FakeSocket) {
      super();
      raw.setTimeout(0);
    }

    override destroy(): this {
      this.raw.destroy();
      return super.destroy();
    }
  }
  return { state, FakeSocket, FakeTlsSocket };
});

vi.mock('node:net', () => ({
  connect: () => {
    const socket = new wire.FakeSocket();
    wire.state.sockets.push(socket);
    setImmediate(() => {
      socket.emit('connect');
      socket.deliver(
        [
          Buffer.from(
            wire.state.greetingEof
              ? '"IMPLEMENTATION" "unfinished'
              : '"STARTTLS"\r\nOK "ready"\r\n',
          ),
        ],
        wire.state.greetingEof,
      );
    });
    return socket;
  },
}));

vi.mock('node:tls', () => ({
  TLSSocket: wire.FakeTlsSocket,
  connect: (options: { socket: InstanceType<typeof wire.FakeSocket> }, connected: () => void) => {
    const socket = new wire.FakeTlsSocket(options.socket);
    wire.state.sockets.push(socket);
    wire.state.onHandshake();
    setImmediate(() => {
      if (wire.state.handshakeFailure) {
        if (wire.state.handshakeFailure !== 'timeout') socket.emit(wire.state.handshakeFailure);
      } else {
        connected();
        socket.deliver([Buffer.from('"SASL" "PLAIN"\r\nOK "ready"\r\n')]);
      }
    });
    return socket;
  },
}));

const { default: sieve, encodePlainAuth } = await import('./sieve.service.js');
const account: AccountConfig = {
  name: 'test',
  email: 'user@example.test',
  username: 'user@example.test',
  password: 'fake-sieve-private-password',
  imap: { host: '127.0.0.1', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.test', port: 465, tls: true, starttls: false, verifySsl: true },
};

// A protocol operation must settle after EOF; the deadline only catches an orphaned promise.
const SETTLE_DEADLINE_MS = 250;
async function settled<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('operation remained pending')),
          SETTLE_DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

beforeEach(() => {
  Object.assign(wire.state, {
    sockets: [],
    commands: [],
    response: [],
    authRefusal: '',
    greetingEof: false,
    literalEof: false,
    handshakeFailure: '',
    onHandshake: () => {},
  });
});

afterEach(async () => {
  try {
    expect(wire.state.sockets.at(-1)?.destroyed).toBe(true);
    wire.state.sockets.forEach((socket) => {
      expect(
        Object.fromEntries(
          ['data', 'error', 'end', 'close', 'timeout'].map((event) => [
            event,
            socket.listenerCount(event),
          ]),
        ),
      ).toEqual({
        data: 0,
        error: 0,
        end: 0,
        close: 0,
        timeout: 0,
      });
    });
  } finally {
    wire.state.sockets.forEach((socket) => {
      socket.destroy();
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});

it('should reject when the server ends halfway through a greeting', async () => {
  wire.state.greetingEof = true;
  await expect(settled(sieve.listScripts(account))).rejects.toThrow(/closed|ended/i);
});

it('should reject when the server ends halfway through a literal', async () => {
  wire.state.response = [Buffer.from('{50}\r\nshort')];
  wire.state.literalEof = true;
  await expect(settled(sieve.getScript(account, 'personal'))).rejects.toThrow(/closed|ended/i);
});

it('should return an intact script when UTF-8 characters are split across packets', async () => {
  const content = 'require ["fileinto"];\nfileinto "Zażółć";\n';
  const response = Buffer.from(`{${Buffer.byteLength(content)}}\r\n${content}\r\nOK "done"\r\n`);
  wire.state.response = Array.from(response, (byte) => Buffer.from([byte]));
  await expect(settled(sieve.getScript(account, 'personal'))).resolves.toBe(content);
});

it('should reject a TLS handshake when the peer closes', async () => {
  wire.state.handshakeFailure = 'close';
  await expect(settled(sieve.listScripts(account))).rejects.toThrow(/TLS.*closed/i);
});

it('should time out an unanswered TLS handshake through the configured socket timeout', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  wire.state.handshakeFailure = 'timeout';
  const started = new Promise<void>((resolve) => {
    wire.state.onHandshake = resolve;
  });
  const outcome = sieve.listScripts(account).then(
    () => 'resolved',
    (err: unknown) => (err instanceof Error ? err.message : 'unknown'),
  );
  await started;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await Promise.race([outcome, Promise.resolve('pending')])).toMatch(/TLS.*timeout/i);
});

it.each(['password', 'plain'] as const)(
  'should redact an echoed %s in an authentication refusal',
  async (shape) => {
    const echoed =
      shape === 'password'
        ? account.password
        : encodePlainAuth(account.username, account.password ?? '');
    wire.state.authRefusal = `NO "refused ${echoed}"\r\n`;
    await expect(sieve.listScripts(account)).rejects.toThrow(
      'AUTHENTICATE failed: NO "refused [redacted]"',
    );
  },
);

it.each([
  ['LISTSCRIPTS', async () => sieve.listScripts(account)],
  ['GETSCRIPT', async () => sieve.getScript(account, 'personal')],
  ['PUTSCRIPT', async () => sieve.putScript(account, 'personal', 'keep;')],
  ['DELETESCRIPT', async () => sieve.deleteScript(account, 'personal')],
  ['SETACTIVE', async () => sieve.activateScript(account, 'personal')],
] as const)(
  'should redact an echoed password from a %s error after authentication',
  async (command, run) => {
    wire.state.response = [Buffer.from(`NO "refused ${account.password}"\r\n`)];
    await expect(run()).rejects.toThrow(`${command} failed: NO "refused [redacted]"`);
  },
);

it('should report a bounded sanitized warning when authentication fails', async () => {
  wire.state.authRefusal = `NO "${account.password} ${'x'.repeat(1000)}"\r\n`;
  const result = await sieve.status(account);
  expect({
    leaked: result.warning?.includes(account.password ?? ''),
    bounded: (result.warning?.length ?? 0) < 500,
  }).toEqual({ leaked: false, bounded: true });
});
