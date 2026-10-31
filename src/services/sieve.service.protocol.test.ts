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
    tlsGreeting: undefined as Buffer[] | undefined,
  };
  class FakeSocket extends EventEmitter {
    destroyed = false;
    readableEnded = false;
    deliver(chunks: Buffer[], eof = false): void {
      chunks.forEach((chunk) => {
        setImmediate(() => {
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
        setImmediate(() => this.emit('close'));
      }
      return this;
    }
  }
  class FakeTlsSocket extends FakeSocket {
    encrypted = true;

    constructor(readonly raw: FakeSocket) {
      super();
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
        socket.deliver(wire.state.tlsGreeting ?? [Buffer.from('"SASL" "PLAIN"\r\nOK "ready"\r\n')]);
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
    tlsGreeting: undefined,
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

it('should time out an unanswered TLS handshake through its production deadline', async () => {
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

const SCRIPT_BYTE_LIMIT = 1_048_576;
const RESPONSE_BYTE_LIMIT = 1_114_112;

async function failureOf(operation: Promise<unknown>): Promise<string> {
  return settled(operation).then(
    () => 'resolved',
    (err: unknown) => (err instanceof Error ? err.message : 'unknown'),
  );
}

it.each(['unterminated header', 'single complete line'] as const)(
  'should reject an oversized %s before retaining its bytes',
  async (shape) => {
    wire.state.response = [
      Buffer.from(
        `${'x'.repeat(RESPONSE_BYTE_LIMIT + 1)}${shape === 'single complete line' ? '\r\nOK\r\n' : ''}`,
      ),
    ];
    expect(await failureOf(sieve.listScripts(account))).toMatch(/response.*1114112/i);
  },
);

it('should count consumed lines against one response budget', async () => {
  const lines = Buffer.from(`"${'x'.repeat(126)}"\r\n`.repeat(100));
  wire.state.response = [...Array.from({ length: 86 }, () => lines), Buffer.from('OK\r\n')];
  expect(await failureOf(sieve.listScripts(account))).toMatch(/response.*1114112/i);
});

it('should count every literal in the same response budget', async () => {
  const literal = Buffer.from(`{600000}\r\n${'x'.repeat(600_000)}\r\n`);
  wire.state.response = [literal, literal, Buffer.from('OK\r\n')];
  expect(await failureOf(sieve.getScript(account, 'personal'))).toMatch(/response.*1114112/i);
});

it('should include bytes already buffered at the start of a response', async () => {
  const greeting = Buffer.from('"SASL" "PLAIN"\r\nOK "ready"\r\n');
  wire.state.tlsGreeting = [
    Buffer.concat([greeting, Buffer.alloc(RESPONSE_BYTE_LIMIT - greeting.length, 120)]),
  ];
  wire.state.authRefusal = `${'x'.repeat(greeting.length + 1)}\r\n`;
  expect(await failureOf(sieve.listScripts(account))).toMatch(/response.*1114112/i);
});

it.each([
  { name: 'oversized', length: '1048577' },
  { name: 'unsafe integer', length: '9007199254740993' },
  { name: 'nonfinite', length: '9'.repeat(400) },
])('should refuse a $name literal length before waiting for its payload', async ({ length }) => {
  wire.state.response = [Buffer.from(`{${length}}\r\n`)];
  expect(await failureOf(sieve.getScript(account, 'personal'))).toMatch(/literal.*1048576/i);
});

it('should accept a literal of exactly one MiB', async () => {
  const content = 'x'.repeat(SCRIPT_BYTE_LIMIT);
  wire.state.response = [Buffer.from(`{${SCRIPT_BYTE_LIMIT}}\r\n${content}\r\nOK\r\n`)];
  await expect(sieve.getScript(account, 'personal')).resolves.toBe(content);
});

it('should accept a response of exactly the byte budget', async () => {
  const prefix = '"last"';
  const suffix = '\r\nOK\r\n';
  wire.state.response = [
    Buffer.from(
      `${prefix}${' '.repeat(RESPONSE_BYTE_LIMIT - prefix.length - suffix.length)}${suffix}`,
    ),
  ];
  await expect(sieve.listScripts(account)).resolves.toEqual([{ name: 'last', active: false }]);
});

function multibyteListResponse(extraBytes: number): { payload: Buffer; names: string[] } {
  const suffix = '\r\nOK\r\n';
  const tail = '"last"';
  const name = (index: number): string => `${String(index).padStart(5, '0')}${'ą'.repeat(120)}`;
  const lineBytes = Buffer.byteLength(`"${name(0)}"\r\n`);
  const count = Math.floor((RESPONSE_BYTE_LIMIT - tail.length - suffix.length) / lineBytes);
  const names = Array.from({ length: count }, (_, index) => name(index));
  const lines = names.map((item) => `"${item}"\r\n`).join('');
  const padding =
    RESPONSE_BYTE_LIMIT - Buffer.byteLength(lines) - tail.length - suffix.length + extraBytes;
  return {
    payload: Buffer.from(`${lines}${tail}${' '.repeat(padding)}${suffix}`),
    names: [...names, 'last'],
  };
}

it('should reject a multibyte response exceeding the byte budget despite fewer code units', async () => {
  wire.state.response = [multibyteListResponse(1).payload];
  expect(await failureOf(sieve.listScripts(account))).toMatch(/response.*1114112/i);
});

it('should accept a multibyte response exactly at the byte budget', async () => {
  const { payload, names } = multibyteListResponse(0);
  wire.state.response = [payload];
  const scripts = await sieve.listScripts(account);
  expect(scripts).toEqual(names.map((name) => ({ name, active: false })));
});

it('should end a response after 30 seconds despite continuing data', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  wire.state.response = [Buffer.from('partial')];
  const outcome = sieve.listScripts(account).then(
    () => 'resolved',
    (err: unknown) => (err instanceof Error ? err.message : 'unknown'),
  );
  while (!wire.state.commands.includes('LISTSCRIPTS\r\n')) {
    // Real immediates drive the socket; only the production deadlines use the fake clock.
    // eslint-disable-next-line no-await-in-loop -- wait for the protocol command before advancing its clock
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  const socket = wire.state.sockets.at(-1);
  for (let step = 0; step < 3; step += 1) {
    // eslint-disable-next-line no-await-in-loop -- deliver traffic between successive clock advances
    await vi.advanceTimersByTimeAsync(9_999);
    socket?.emit('data', Buffer.from('x'));
  }
  expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe('pending');
  await vi.advanceTimersByTimeAsync(3);
  expect(await Promise.race([outcome, Promise.resolve('pending')])).toMatch(/response.*timeout/i);
});

it('should end a TLS handshake after 30 seconds despite continuing traffic', async () => {
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
  const socket = wire.state.sockets.at(-1);
  for (let step = 0; step < 3; step += 1) {
    // eslint-disable-next-line no-await-in-loop -- deliver traffic between successive clock advances
    await vi.advanceTimersByTimeAsync(9_999);
    socket?.emit('data', Buffer.from('x'));
  }
  expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe('pending');
  await vi.advanceTimersByTimeAsync(3);
  expect(await Promise.race([outcome, Promise.resolve('pending')])).toMatch(/TLS.*timeout/i);
});

it('should clear the response and handshake deadlines after success', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  wire.state.response = [Buffer.from('OK\r\n')];
  await expect(sieve.listScripts(account)).resolves.toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
