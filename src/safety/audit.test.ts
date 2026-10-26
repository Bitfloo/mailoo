import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { permissionBits } from '../test-support/config-sandbox.js';
import type { AuditEntry } from '../types/index.js';
import type audit from './audit.js';

type Audit = typeof audit;

/** `leaf` inside `levels` containers made by `wrap`, the outermost first. */
function nested(levels: number, leaf: unknown, wrap: (inner: unknown) => unknown): unknown {
  return Array.from({ length: levels }).reduce<unknown>((inner) => wrap(inner), leaf);
}

/** Written out, so the depth tests fail on the walk rather than on a missing export. */
const DEPTH_LIMIT = 16;

const inObject = (inner: unknown) => ({ next: inner });
const inArray = (inner: unknown) => [inner];

class Credentials {
  token = 'tok-literal-0001';

  toString(): string {
    return this.token;
  }
}

/** An object that refers back to itself and counts every read of it: a key, a property, its type. */
function watched(): { value: object; reads: () => number } {
  let reads = 0;
  const target: Record<string, unknown> = {};
  // Each proxy operation first looks its trap up on the handler, so counting lookups counts them all.
  const handler = new Proxy<ProxyHandler<object>>(
    {},
    {
      get: (_, trap: keyof typeof Reflect) => {
        reads += 1;
        return Reflect[trap];
      },
    },
  );
  const value = new Proxy(target, handler);
  target.self = value;
  return { value, reads: () => reads };
}

/** Objects other than arrays and plain objects, and what an entry writes for each. */
const NON_PLAIN_CASES = [
  {
    name: 'a Date',
    value: new Date('2026-11-02T09:00:00.000Z'),
    logged: '2026-11-02T09:00:00.000Z',
  },
  { name: 'an invalid Date', value: new Date('not a date'), logged: 'Invalid Date' },
  {
    name: 'a URL',
    value: new URL('https://hooks.example.com/notify?channel=ops'),
    logged: 'https://hooks.example.com/notify?[REDACTED]',
  },
  { name: 'a Buffer', value: Buffer.from('bytes-literal-0002'), logged: '[Binary]' },
  { name: 'a Uint8Array', value: new Uint8Array([98, 121, 116, 101]), logged: '[Binary]' },
  { name: 'a Float64Array', value: new Float64Array([0.5, 2]), logged: '[Binary]' },
  { name: 'a DataView', value: new DataView(new ArrayBuffer(4)), logged: '[Binary]' },
  { name: 'an ArrayBuffer', value: new ArrayBuffer(4), logged: '[Binary]' },
  { name: 'a Map', value: new Map([['to', 'a@example.com']]), logged: '[Object]' },
  { name: 'a Set', value: new Set(['a@example.com']), logged: '[Object]' },
  { name: 'a class instance with its own toString', value: new Credentials(), logged: '[Object]' },
];

const URL_USER = 'user-literal-0004';
const URL_PASSWORD = 'pw-literal-0005';
const URL_QUERY = 'query-literal-0006';
const URL_FRAGMENT = 'fragment-literal-0007';
const URL_LITERALS = [URL_USER, URL_PASSWORD, URL_QUERY, URL_FRAGMENT];

/** Split so the source does not contain a script-URL literal. The audit must still redact it. */
const SCRIPT_SCHEME = 'java'.concat('script:');

/** A URL is written as scheme, host and path; anything else it held leaves one marker. */
const URL_CASES = [
  {
    name: 'a user name and a password',
    url: `https://${URL_USER}:${URL_PASSWORD}@hooks.example.com/notify`,
    logged: 'https://hooks.example.com/notify?[REDACTED]',
  },
  {
    name: 'a user name alone',
    url: `https://${URL_USER}@hooks.example.com/notify`,
    logged: 'https://hooks.example.com/notify?[REDACTED]',
  },
  {
    name: 'a password alone',
    url: `https://:${URL_PASSWORD}@hooks.example.com/notify`,
    logged: 'https://hooks.example.com/notify?[REDACTED]',
  },
  {
    name: 'a query',
    url: `https://hooks.example.com/notify?token=${URL_QUERY}`,
    logged: 'https://hooks.example.com/notify?[REDACTED]',
  },
  {
    name: 'a fragment',
    url: `https://hooks.example.com/notify#${URL_FRAGMENT}`,
    logged: 'https://hooks.example.com/notify?[REDACTED]',
  },
  {
    name: 'credentials, a port, a query and a fragment',
    url: `https://${URL_USER}:${URL_PASSWORD}@hooks.example.com:8443/notify?token=${URL_QUERY}#${URL_FRAGMENT}`,
    logged: 'https://hooks.example.com:8443/notify?[REDACTED]',
  },
  // Its origin is the string "null", so the host is read on its own.
  {
    name: 'a scheme without an origin and credentials',
    url: `redis://${URL_USER}:${URL_PASSWORD}@cache.example.com:6380/0`,
    logged: 'redis://cache.example.com:6380/0?[REDACTED]',
  },
  {
    name: 'only a scheme, a host, a port and a path',
    url: 'https://hooks.example.com:8443/notify/v1',
    logged: 'https://hooks.example.com:8443/notify/v1',
  },
  {
    name: 'a mailto address',
    url: `mailto:${URL_USER}@example.com`,
    logged: 'mailto:[REDACTED]',
  },
  {
    name: 'a data URL',
    url: `data:text/plain,${URL_QUERY}`,
    logged: 'data:[REDACTED]',
  },
  {
    name: 'a javascript URL',
    url: `${SCRIPT_SCHEME}${URL_FRAGMENT}`,
    logged: `${SCRIPT_SCHEME}[REDACTED]`,
  },
];

describe('Audit Logger', () => {
  let dataHome: string;
  let logDir: string;
  let auditLogger: Audit;

  /** AUDIT_LOG_PATH is fixed when xdg.ts loads, so each test imports a fresh copy. */
  async function loadAudit(): Promise<Audit> {
    vi.stubEnv('XDG_DATA_HOME', dataHome);
    vi.resetModules();
    return (await import('./audit.js')).default;
  }

  async function readEntries(): Promise<AuditEntry[]> {
    const text = await fs.readFile(auditLogger.AUDIT_LOG_PATH, 'utf-8');
    return text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AuditEntry);
  }

  /** The params of each entry written, and the stderr lines a lost entry leaves instead. */
  async function loggedParams(
    params: Record<string, unknown>,
  ): Promise<{ stderr: string[]; params: unknown[] }> {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await auditLogger.log('test', 'x', params, 'ok');
    const entries = await readEntries().catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    return {
      stderr: stderr.mock.calls.map(([line]) => String(line)),
      params: entries.map((entry) => entry.params),
    };
  }

  beforeEach(async () => {
    dataHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-audit-'));
    logDir = path.join(dataHome, 'mailoo');
    auditLogger = await loadAudit();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.chmod(dataHome, 0o700).catch(() => undefined);
    await fs.rm(dataHome, { recursive: true, force: true });
  });

  it('logs an entry with tool, account, and result', async () => {
    await auditLogger.log('send_email', 'personal', { to: ['a@example.com'] }, 'ok');
    const [entry] = await readEntries();
    expect(entry).toMatchObject({
      tool: 'send_email',
      account: 'personal',
      result: 'ok',
      params: { to: ['a@example.com'] },
    });
  });

  it('should record the account the resolver names when the tool passed an alias or nothing', async () => {
    auditLogger.setAccountResolver((key) => (key === '' ? 'personal' : key.toLowerCase()));
    await auditLogger.log('send_email', '', {}, 'ok');
    await auditLogger.log('send_email', 'WORK', {}, 'ok');
    expect((await readEntries()).map((entry) => entry.account)).toEqual(['personal', 'work']);
  });

  it('should keep the account as given when the resolver cannot name it', async () => {
    auditLogger.setAccountResolver(() => {
      throw new Error('Account "ghost" not found');
    });
    await auditLogger.log('send_email', 'ghost', {}, 'error', 'Account "ghost" not found');
    const [entry] = await readEntries();
    expect(entry?.account).toBe('ghost');
  });

  it('redacts password field', async () => {
    await auditLogger.log(
      'send_email',
      'x',
      { password: 'secret123', to: ['a@example.com'] },
      'ok',
    );
    const [entry] = await readEntries();
    expect(entry.params).toEqual({ password: '[REDACTED]', to: ['a@example.com'] });
  });

  it('redacts body, bodyText, bodyHtml, content_base64', async () => {
    await auditLogger.log(
      'send_email',
      'x',
      {
        body: 'secret body',
        bodyText: 'text',
        bodyHtml: '<p>html</p>',
        content_base64: 'base64data',
        subject: 'visible',
      },
      'ok',
    );
    const [entry] = await readEntries();
    expect(entry.params).toEqual({
      body: '[REDACTED]',
      bodyText: '[REDACTED]',
      bodyHtml: '[REDACTED]',
      content_base64: '[REDACTED]',
      subject: 'visible',
    });
  });

  it('redacts OAuth token fields in camelCase and snake_case', async () => {
    await auditLogger.log(
      'oauth',
      'x',
      {
        clientSecret: 'cs',
        client_secret: 'cs_snake',
        refreshToken: 'rt',
        refresh_token: 'rt_snake',
        accessToken: 'at',
        access_token: 'at_snake',
        account: 'personal',
      },
      'ok',
    );
    const [entry] = await readEntries();
    expect(entry.params).toEqual({
      clientSecret: '[REDACTED]',
      client_secret: '[REDACTED]',
      refreshToken: '[REDACTED]',
      refresh_token: '[REDACTED]',
      accessToken: '[REDACTED]',
      access_token: '[REDACTED]',
      account: 'personal',
    });
  });

  it('should redact the id token in camelCase and snake_case', async () => {
    await auditLogger.log(
      'oauth',
      'x',
      { idToken: 'it', id_token: 'it_snake', account: 'personal' },
      'ok',
    );
    const [entry] = await readEntries();
    expect(entry.params).toEqual({
      idToken: '[REDACTED]',
      id_token: '[REDACTED]',
      account: 'personal',
    });
  });

  it('redacts nested sensitive fields', async () => {
    await auditLogger.log('test', 'x', { nested: { password: 'abc', safe: 'ok' } }, 'ok');
    const [entry] = await readEntries();
    expect(entry.params).toEqual({ nested: { password: '[REDACTED]', safe: 'ok' } });
  });

  it('should redact a sensitive field of each object held in an array', async () => {
    await auditLogger.log(
      'test',
      'x',
      {
        attachments: [
          { filename: 'report.pdf', content_base64: 'JVBERi0xLjQK' },
          { filename: 'notes.txt', content_base64: 'aGVsbG8K' },
        ],
      },
      'ok',
    );
    const [entry] = await readEntries();
    expect(entry.params).toEqual({
      attachments: [
        { filename: 'report.pdf', content_base64: '[REDACTED]' },
        { filename: 'notes.txt', content_base64: '[REDACTED]' },
      ],
    });
  });

  it('should redact a sensitive field of an object in an array nested in an array', async () => {
    await auditLogger.log(
      'test',
      'x',
      { batches: [[{ refresh_token: 'rt', label: 'kept' }]] },
      'ok',
    );
    const [entry] = await readEntries();
    expect(entry.params).toEqual({ batches: [[{ refresh_token: '[REDACTED]', label: 'kept' }]] });
  });

  it('should mask the whole value when a sensitive key holds an object or an array', async () => {
    await auditLogger.log(
      'test',
      'x',
      {
        refresh_token: ['rt-literal'],
        password: { value: 'pw-literal' },
        nested: { id_token: ['it-literal'] },
      },
      'ok',
    );
    const line = await fs.readFile(auditLogger.AUDIT_LOG_PATH, 'utf-8');
    const [entry] = await readEntries();
    expect({
      params: entry.params,
      leaked: ['rt-literal', 'pw-literal', 'it-literal'].filter((literal) =>
        line.includes(literal),
      ),
    }).toEqual({
      params: {
        refresh_token: '[REDACTED]',
        password: '[REDACTED]',
        nested: { id_token: '[REDACTED]' },
      },
      leaked: [],
    });
  });

  // typeof null is 'object': recursing into an array item that is null would throw and lose the entry.
  it('should keep null, strings and numbers inside an array as given', async () => {
    await auditLogger.log('test', 'x', { items: [null, 'a@example.com', 42] }, 'ok');
    const [entry] = await readEntries();
    expect(entry.params).toEqual({ items: [null, 'a@example.com', 42] });
  });

  // A cycle used to recurse until the stack overflowed, and the entry was lost.
  it('should write [Circular] for a param that refers back to an object holding it', async () => {
    const params: Record<string, unknown> = { subject: 'kept' };
    params.self = params;
    const list: unknown[] = ['a@example.com'];
    list.push(list);
    params.to = list;
    expect(await loggedParams(params)).toEqual({
      stderr: [],
      params: [{ subject: 'kept', self: '[Circular]', to: ['a@example.com', '[Circular]'] }],
    });
  });

  it('should write [Circular] for an object below the top that refers back to itself or its parent', async () => {
    const inner: Record<string, unknown> = { subject: 'kept' };
    inner.back = inner;
    const child: Record<string, unknown> = { subject: 'kept' };
    const parent = { child };
    child.up = parent;
    expect(await loggedParams({ chain: { inner }, parent })).toEqual({
      stderr: [],
      params: [
        {
          chain: { inner: { subject: 'kept', back: '[Circular]' } },
          parent: { child: { subject: 'kept', up: '[Circular]' } },
        },
      ],
    });
  });

  it.each([
    { name: 'an array', shared: ['a@example.com'] },
    { name: 'a plain object', shared: { address: 'a@example.com' } },
  ])(
    'should write $name shared by two params out under each when it holds no cycle',
    async ({ shared }) => {
      expect(await loggedParams({ to: shared, cc: shared })).toEqual({
        stderr: [],
        params: [{ to: shared, cc: shared }],
      });
    },
  );

  it('should export 16 as the deepest a param is written', async () => {
    expect((await import('./audit.js')).PARAMS_MAX_DEPTH).toBe(DEPTH_LIMIT);
  });

  it('should write a param nested exactly as deep as the limit whole', async () => {
    expect(await loggedParams({ chain: nested(DEPTH_LIMIT, 'kept', inObject) })).toEqual({
      stderr: [],
      params: [{ chain: nested(DEPTH_LIMIT, 'kept', inObject) }],
    });
  });

  it('should write [Truncated] for the object one level past the limit', async () => {
    expect(await loggedParams({ chain: nested(DEPTH_LIMIT + 1, 'kept', inObject) })).toEqual({
      stderr: [],
      params: [{ chain: nested(DEPTH_LIMIT, '[Truncated]', inObject) }],
    });
  });

  it('should log a param nested 100000 arrays deep with [Truncated] past the limit', async () => {
    expect(await loggedParams({ chain: nested(100_000, 'kept', inArray) })).toEqual({
      stderr: [],
      params: [{ chain: nested(DEPTH_LIMIT, '[Truncated]', inArray) }],
    });
  });

  it.each(NON_PLAIN_CASES)(
    'should write $name held by a param as $logged',
    async ({ value, logged }) => {
      expect(await loggedParams({ value })).toEqual({ stderr: [], params: [{ value: logged }] });
    },
  );

  // The leaf sits where a container would be cut: the limit bounds the walk, and a leaf is not walked.
  it.each(NON_PLAIN_CASES)(
    'should write $name nested past the depth limit as $logged, not [Truncated]',
    async ({ value, logged }) => {
      expect(await loggedParams({ chain: nested(DEPTH_LIMIT, value, inObject) })).toEqual({
        stderr: [],
        params: [{ chain: nested(DEPTH_LIMIT, logged, inObject) }],
      });
    },
  );

  it.each(URL_CASES)('should write a URL with $name as $logged', async ({ url, logged }) => {
    const written = await loggedParams({ hook: new URL(url) });
    const line = await fs.readFile(auditLogger.AUDIT_LOG_PATH, 'utf-8');
    expect({
      ...written,
      leaked: URL_LITERALS.filter((literal) => line.includes(literal)),
    }).toEqual({ stderr: [], params: [{ hook: logged }], leaked: [] });
  });

  it('should strip the URLs held in arrays and nested objects the same way', async () => {
    const url = () =>
      new URL(`https://${URL_USER}:${URL_PASSWORD}@hooks.example.com/notify?token=${URL_QUERY}`);
    const kept = 'https://hooks.example.com/notify?[REDACTED]';
    expect(
      await loggedParams({ hooks: [url(), { target: url() }], nested: { deeper: [[url()]] } }),
    ).toEqual({
      stderr: [],
      params: [{ hooks: [kept, { target: kept }], nested: { deeper: [[kept]] } }],
    });
  });

  it('should write each non-plain object inside an array as its own text or marker', async () => {
    expect(await loggedParams({ items: NON_PLAIN_CASES.map((c) => c.value) })).toEqual({
      stderr: [],
      params: [{ items: NON_PLAIN_CASES.map((c) => c.logged) }],
    });
  });

  it('should walk an object without a prototype like a plain one', async () => {
    const bare = Object.assign(Object.create(null) as object, { subject: 'kept', password: 'pw' });
    expect(await loggedParams({ bare })).toEqual({
      stderr: [],
      params: [{ bare: { subject: 'kept', password: '[REDACTED]' } }],
    });
  });

  it('should mask bytes, a Date and a cycle held by a sensitive key before writing them', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      await loggedParams({
        content_base64: Buffer.from('bytes-literal-0003'),
        password: new Date('2026-11-02T09:00:00.000Z'),
        refresh_token: cyclic,
      }),
    ).toEqual({
      stderr: [],
      params: [
        { content_base64: '[REDACTED]', password: '[REDACTED]', refresh_token: '[REDACTED]' },
      ],
    });
  });

  it('should write [REDACTED] for a sensitive key without reading anything of its value', async () => {
    const [top, inner, listed] = [watched(), watched(), watched()];
    const logged = await loggedParams({
      refresh_token: top.value,
      nested: { password: inner.value },
      items: [{ id_token: listed.value }],
    });
    expect({ ...logged, reads: [top, inner, listed].map((value) => value.reads()) }).toEqual({
      stderr: [],
      params: [
        {
          refresh_token: '[REDACTED]',
          nested: { password: '[REDACTED]' },
          items: [{ id_token: '[REDACTED]' }],
        },
      ],
      reads: [0, 0, 0],
    });
  });

  // schedule_email is the one caller that logs its whole input; its recipient
  // arrays hold strings, which redaction must pass through unchanged.
  it('should keep the recipient arrays and redact the body when schedule_email logs its params', async () => {
    await auditLogger.log(
      'schedule_email',
      'personal',
      {
        account: 'personal',
        to: ['a@example.com', 'b@example.com'],
        subject: 'Quarterly report',
        body: 'Numbers attached.',
        send_at: '2026-11-02T09:00:00Z',
        cc: ['c@example.com'],
        bcc: [],
        html: false,
      },
      'ok',
    );
    const [entry] = await readEntries();
    expect(entry.params).toEqual({
      account: 'personal',
      to: ['a@example.com', 'b@example.com'],
      subject: 'Quarterly report',
      body: '[REDACTED]',
      send_at: '2026-11-02T09:00:00Z',
      cc: ['c@example.com'],
      bcc: [],
      html: false,
    });
  });

  it('should stamp the entry with the current time in ISO 8601 when logging', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

    await auditLogger.log('send_email', 'x', {}, 'ok');

    const [entry] = await readEntries();
    expect(entry.ts).toBe('2026-01-02T03:04:05.000Z');
  });

  // typeof null is 'object': recursing into it would throw and lose the whole entry.
  it('should keep a null param as null when logging', async () => {
    await auditLogger.log('send_email', 'x', { cc: null, to: ['a@example.com'] }, 'ok');

    const [entry] = await readEntries();
    expect(entry.params).toEqual({ cc: null, to: ['a@example.com'] });
  });

  it('includes error field when provided', async () => {
    await auditLogger.log('send_email', 'x', {}, 'error', 'Connection failed');
    const [entry] = await readEntries();
    expect(entry).toMatchObject({ result: 'error', error: 'Connection failed' });
  });

  it('does not include error field when not provided', async () => {
    await auditLogger.log('send_email', 'x', {}, 'ok');
    const [entry] = await readEntries();
    expect(entry).not.toHaveProperty('error');
  });

  it('should append one line per call when called twice', async () => {
    await auditLogger.log('send_email', 'x', { subject: 'first' }, 'ok');
    await auditLogger.log('send_email', 'x', { subject: 'second' }, 'ok');
    const entries = await readEntries();
    expect(entries.map((entry) => entry.params.subject)).toEqual(['first', 'second']);
  });

  it('should create the log directory 0700 and the log file 0600 when neither exists', async () => {
    await auditLogger.log('send_email', 'x', { to: ['a@example.com'] }, 'ok');
    expect({
      dir: permissionBits((await fs.stat(logDir)).mode),
      file: permissionBits((await fs.stat(auditLogger.AUDIT_LOG_PATH)).mode),
    }).toEqual({ dir: 0o700, file: 0o600 });
  });

  it.each([
    { label: 'world-readable 0755/0644', dirMode: 0o755, fileMode: 0o644 },
    { label: 'group-readable 0750/0640', dirMode: 0o750, fileMode: 0o640 },
  ])(
    'should tighten an existing $label directory and log file on the first write',
    async ({ dirMode, fileMode }) => {
      await fs.mkdir(logDir);
      await fs.chmod(logDir, dirMode);
      await fs.writeFile(auditLogger.AUDIT_LOG_PATH, '');
      await fs.chmod(auditLogger.AUDIT_LOG_PATH, fileMode);

      await auditLogger.log('send_email', 'x', { to: ['a@example.com'] }, 'ok');

      expect({
        dir: permissionBits((await fs.stat(logDir)).mode),
        file: permissionBits((await fs.stat(auditLogger.AUDIT_LOG_PATH)).mode),
      }).toEqual({ dir: 0o700, file: 0o600 });
    },
  );

  it('should check the log file mode once per process and not again on later writes', async () => {
    await auditLogger.log('send_email', 'x', { subject: 'first' }, 'ok');
    await fs.chmod(auditLogger.AUDIT_LOG_PATH, 0o644);

    await auditLogger.log('send_email', 'x', { subject: 'second' }, 'ok');

    expect(permissionBits((await fs.stat(auditLogger.AUDIT_LOG_PATH)).mode)).toBe(0o644);
  });

  it('should leave the mode of a symlinked data directory unchanged when logging', async () => {
    const operatorDir = path.join(dataHome, 'operator-mailoo');
    await fs.mkdir(operatorDir);
    await fs.chmod(operatorDir, 0o755);
    await fs.symlink(operatorDir, logDir);

    await auditLogger.log('send_email', 'x', { subject: 'through the link' }, 'ok');

    expect({
      targetMode: permissionBits((await fs.stat(operatorDir)).mode),
      subjects: (await readEntries()).map((entry) => entry.params.subject),
    }).toEqual({ targetMode: 0o755, subjects: ['through the link'] });
  });

  it('should recreate the directory 0700 and the file 0600 when both are removed while running', async () => {
    await auditLogger.log('send_email', 'x', { subject: 'first' }, 'ok');
    await fs.rm(logDir, { recursive: true });

    await auditLogger.log('send_email', 'x', { subject: 'second' }, 'ok');

    expect({
      dir: permissionBits((await fs.stat(logDir)).mode),
      file: permissionBits((await fs.stat(auditLogger.AUDIT_LOG_PATH)).mode),
      subjects: (await readEntries()).map((entry) => entry.params.subject),
    }).toEqual({ dir: 0o700, file: 0o600, subjects: ['second'] });
  });

  // A tool audits after its side effect. A throw here turned a delivered email
  // into an error result, and an agent retry sent it twice.
  it('should resolve when the log file cannot be written', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await fs.mkdir(auditLogger.AUDIT_LOG_PATH, { recursive: true });

    await expect(
      auditLogger.log('send_email', 'x', { to: ['a@example.com'] }, 'ok'),
    ).resolves.toBeUndefined();
  });

  it('should write exactly one stderr line when the write fails', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await fs.mkdir(auditLogger.AUDIT_LOG_PATH, { recursive: true });

    await auditLogger.log('send_email', 'x', { to: ['a@example.com'] }, 'ok');

    expect(stderr.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringMatching(/^\[mailoo\] audit log write failed: [^\n]+\n$/),
    ]);
  });

  it('should keep recipients and subject out of the stderr line when the write fails', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await fs.mkdir(auditLogger.AUDIT_LOG_PATH, { recursive: true });

    await auditLogger.log('send_email', 'x', { to: ['a@example.com'], subject: 'Quarterly' }, 'ok');

    expect(stderr.mock.calls.join('')).not.toMatch(/a@example\.com|Quarterly/);
  });

  it('should resolve when the log directory cannot be created', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await fs.writeFile(logDir, 'not a directory');

    await expect(auditLogger.log('send_email', 'x', {}, 'ok')).resolves.toBeUndefined();
  });

  it('should redact a sensitive key whatever its case or separator, without reading the getter', async () => {
    let reads = 0;
    const params: Record<string, unknown> = {};
    Object.defineProperty(params, 'Password', {
      enumerable: true,
      get() {
        reads += 1;
        return 'pw-literal-0008';
      },
    });
    params.ACCESS_TOKEN = 'tok-literal-0009';
    params['client-secret'] = 'sec-literal-0010';

    expect({ ...(await loggedParams(params)), reads }).toEqual({
      stderr: [],
      params: [
        { Password: '[REDACTED]', ACCESS_TOKEN: '[REDACTED]', 'client-secret': '[REDACTED]' },
      ],
      reads: 0,
    });
  });

  it('should keep a __proto__ key as data and leave Object.prototype alone', async () => {
    const params = JSON.parse('{"__proto__":{"note":"kept-note"},"subject":"hello"}') as Record<
      string,
      unknown
    >;

    await auditLogger.log('test', 'x', params, 'ok');

    const entry = (await readEntries())[0];
    expect({
      proto: Object.getOwnPropertyDescriptor(entry?.params, '__proto__')?.value,
      subject: entry?.params.subject,
      polluted: Object.hasOwn(Object.prototype, 'note'),
    }).toEqual({
      proto: { note: 'kept-note' },
      subject: 'hello',
      polluted: false,
    });
  });

  it('should write an accessor that is not a sensitive key as a marker', async () => {
    let reads = 0;
    const params: Record<string, unknown> = {};
    Object.defineProperty(params, 'label', {
      enumerable: true,
      get() {
        reads += 1;
        return 'inbox';
      },
    });

    expect({ ...(await loggedParams(params)), reads }).toEqual({
      stderr: [],
      params: [{ label: '[Accessor]' }],
      reads: 0,
    });
  });

  it('should walk an array by index when its map has been replaced', async () => {
    const items = ['kept'];
    Object.defineProperty(items, 'map', {
      value: () => {
        throw new Error('shadowed map');
      },
    });

    expect(await loggedParams({ items })).toEqual({ stderr: [], params: [{ items: ['kept'] }] });
  });
});
