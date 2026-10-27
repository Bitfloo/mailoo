/**
 * The runner's CI and VITEST variables are not the operator's env. Each test
 * passes the env object the decision reads, and a fetch that records calls.
 */

import fs, { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  InstallCountFetch,
  InstallCountRequest,
  InstallCountResult,
} from './install-count.js';
import { INSTALL_COUNT_TIMEOUT_MS, recordInstall } from './install-count.js';

const VERSION = '9.9.9';
const NODE_MAJOR = 24;
const COLLECTOR = 'https://collector.example/install';
// README promises that a collector which has not answered is dropped after this bound.
const DOCUMENTED_TIMEOUT_MS = 3_000;

const roots: string[] = [];

function opted(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    MAILOO_INSTALL_COUNTER: '1',
    MAILOO_INSTALL_COUNTER_URL: COLLECTOR,
    ...over,
  };
}

function recording(status: number): {
  seen: { url: string; init: InstallCountRequest }[];
  fetchImpl: InstallCountFetch;
} {
  const seen: { url: string; init: InstallCountRequest }[] = [];
  const fetchImpl: InstallCountFetch = async (url, init) => {
    seen.push({ url, init });
    return { status, body: null };
  };
  return { seen, fetchImpl };
}

async function stateDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mailoo-install-count-'));
  roots.push(root);
  return join(root, 'state');
}

async function count(
  dir: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: InstallCountFetch,
  version = VERSION,
  nodeMajor = NODE_MAJOR,
): Promise<InstallCountResult> {
  return recordInstall({ version, nodeMajor, env, stateDir: dir, fetchImpl });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe('install count', () => {
  it.each([
    ['unset', {}],
    ['empty', { MAILOO_INSTALL_COUNTER: '' }],
    ['0', { MAILOO_INSTALL_COUNTER: '0' }],
    ['false', { MAILOO_INSTALL_COUNTER: 'false' }],
    ['off', { MAILOO_INSTALL_COUNTER: 'off' }],
    ['no', { MAILOO_INSTALL_COUNTER: 'no' }],
    ['unrecognized', { MAILOO_INSTALL_COUNTER: 'enabled' }],
  ] as const)('should not send when the switch is %s', async (_label, flag) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(
      dir,
      { MAILOO_INSTALL_COUNTER_URL: COLLECTOR, ...flag },
      fetch.fetchImpl,
    );
    expect(result).toEqual({ sent: false, reason: 'disabled' });
    expect(fetch.seen).toHaveLength(0);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['true', '1', 'yes', 'TRUE'])('should not send when CI is %s', async (ci) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted({ CI: ci }), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'automation' });
    expect(fetch.seen).toHaveLength(0);
    await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on', ' on '])(
    'should send when MAILOO_INSTALL_COUNTER is %j',
    async (flag) => {
      const fetch = recording(204);
      const dir = await stateDir();
      const result = await count(dir, opted({ MAILOO_INSTALL_COUNTER: flag }), fetch.fetchImpl);
      expect(result).toEqual({ sent: true, reason: 'sent' });
      expect(fetch.seen).toHaveLength(1);
    },
  );

  it('should send when CI is false and the counter is on', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted({ CI: 'false' }), fetch.fetchImpl);
    expect(result).toEqual({ sent: true, reason: 'sent' });
    expect(fetch.seen).toHaveLength(1);
  });

  it.each([
    ['VITEST', { VITEST: 'true' }],
    ['NODE_ENV=test', { NODE_ENV: 'test' }],
  ] as const)('should not send when %s is set', async (_label, extra) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted(extra), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'automation' });
    expect(fetch.seen).toHaveLength(0);
  });

  it.each(['unset', 'blank'] as const)('should not send when the endpoint is %s', async (kind) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const env =
      kind === 'unset'
        ? { MAILOO_INSTALL_COUNTER: '1' }
        : opted({ MAILOO_INSTALL_COUNTER_URL: '   ' });
    const result = await count(dir, env, fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'no-endpoint' });
    expect(fetch.seen).toHaveLength(0);
  });

  it.each([
    'http://collector.example/install',
    'https://user:secret@collector.example/install',
    'ftp://collector.example/install',
  ])('should not send to %s', async (url) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted({ MAILOO_INSTALL_COUNTER_URL: url }), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'rejected' });
    expect(fetch.seen).toHaveLength(0);
  });

  it.each(['http://127.0.0.1/install', 'http://localhost/install', 'http://[::1]/install'])(
    'should send to loopback %s',
    async (url) => {
      const fetch = recording(204);
      const dir = await stateDir();
      const result = await count(dir, opted({ MAILOO_INSTALL_COUNTER_URL: url }), fetch.fetchImpl);
      expect(result.sent).toBe(true);
      expect(fetch.seen[0]?.url).toBe(url);
    },
  );

  it.each(['user@example.com', '0.2'])('should not send when version is %s', async (version) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted(), fetch.fetchImpl, version);
    expect(result).toEqual({ sent: false, reason: 'rejected' });
    expect(fetch.seen).toHaveLength(0);
  });

  it.each([24.5, 100, -1])('should not send when node major is %s', async (nodeMajor) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted(), fetch.fetchImpl, VERSION, nodeMajor);
    expect(result).toEqual({ sent: false, reason: 'rejected' });
    expect(fetch.seen).toHaveLength(0);
  });

  it('should post only the install fields on the first opted-in start', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted(), fetch.fetchImpl);
    expect(result).toEqual({ sent: true, reason: 'sent' });
    expect(fetch.seen).toHaveLength(1);
    const call = fetch.seen[0];
    expect(call?.url).toBe(COLLECTOR);
    expect(Object.keys(call?.init ?? {}).sort()).toEqual(
      ['body', 'credentials', 'headers', 'method', 'redirect', 'signal'].sort(),
    );
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('manual');
    expect(call?.init.credentials).toBe('omit');
    expect(call?.init.headers).toEqual({
      'content-type': 'application/json',
      'user-agent': 'mailoo',
    });
    expect(JSON.parse(call?.init.body ?? '')).toEqual({
      product: 'mailoo',
      version: VERSION,
      event: 'install',
      node_major: NODE_MAJOR,
    });
    expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe('1\n');
  });

  it('should write the marker with mode 0600', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    await count(dir, opted(), fetch.fetchImpl);
    const info = await stat(join(dir, 'install-count'));
    // Permission bits only; the high bits are the file type.
    // eslint-disable-next-line no-bitwise
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('should not send again after that generation is recorded', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    const env = opted();
    expect(await count(dir, env, fetch.fetchImpl)).toEqual({ sent: true, reason: 'sent' });
    expect(await count(dir, env, fetch.fetchImpl)).toEqual({ sent: false, reason: 'already' });
    expect(fetch.seen).toHaveLength(1);
  });

  it('should not send again after the collector refused the first start', async () => {
    const fetch = recording(503);
    const dir = await stateDir();
    const env = opted();
    expect(await count(dir, env, fetch.fetchImpl)).toEqual({ sent: false, reason: 'refused' });
    const again = recording(204);
    expect(await count(dir, env, again.fetchImpl)).toEqual({ sent: false, reason: 'already' });
    expect(again.seen).toHaveLength(0);
  });

  it('should report a redirect as refused without following it', async () => {
    const fetch = recording(302);
    const dir = await stateDir();
    const result = await count(dir, opted(), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'refused' });
    expect(fetch.seen).toHaveLength(1);
    expect(fetch.seen[0]?.init.redirect).toBe('manual');
  });

  it('should send again when the marker is an older generation', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'install-count'), '0\n');
    const result = await count(dir, opted(), fetch.fetchImpl);
    expect(result).toEqual({ sent: true, reason: 'sent' });
    expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe('1\n');
  });

  it('should send once when three servers start at the same time over an older marker', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'install-count'), '0\n');
    const env = opted();
    const results = await Promise.all([
      count(dir, env, fetch.fetchImpl),
      count(dir, env, fetch.fetchImpl),
      count(dir, env, fetch.fetchImpl),
    ]);
    expect(fetch.seen).toHaveLength(1);
    expect(results.map((r) => r.reason).sort()).toEqual(['already', 'already', 'sent']);
    expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe('1\n');
  });

  it('should not send over an older marker when that generation was already claimed', async () => {
    // A start that read the older marker before another start replaced it ends here.
    const fetch = recording(204);
    const dir = await stateDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'install-count'), '0\n');
    await writeFile(join(dir, 'install-count.1.claim'), '');
    expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({ sent: false, reason: 'already' });
    expect(fetch.seen).toHaveLength(0);
  });

  it('should keep the generation claim so a start that read the older marker late does not send', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'install-count'), '0\n');
    const realReadFile = fs.readFile.bind(fs) as (
      file: string,
      encoding: 'utf8',
    ) => Promise<string>;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let readDone: () => void = () => {};
    const lateRead = new Promise<void>((resolve) => {
      readDone = resolve;
    });
    // The late start reads the older marker now but only acts on it after the other start
    // has claimed, replaced the marker, and sent.
    vi.spyOn(fs, 'readFile').mockImplementationOnce((async (file: string, encoding: 'utf8') => {
      const text = await realReadFile(file, encoding);
      readDone();
      await gate;
      return text;
    }) as unknown as typeof fs.readFile);
    const late = count(dir, opted(), fetch.fetchImpl);
    await lateRead;
    expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({ sent: true, reason: 'sent' });
    release();
    expect(await late).toEqual({ sent: false, reason: 'already' });
    expect(fetch.seen).toHaveLength(1);
    await expect(stat(join(dir, 'install-count.1.claim'))).resolves.toBeDefined();
  });

  it('should send again after the marker file is deleted', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({ sent: true, reason: 'sent' });
    await rm(join(dir, 'install-count'));
    expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({ sent: true, reason: 'sent' });
    expect(fetch.seen).toHaveLength(2);
  });

  it('should read the env argument and not the process environment', async () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('MAILOO_INSTALL_COUNTER', '0');
    vi.stubEnv('MAILOO_INSTALL_COUNTER_URL', 'https://collector.example/from-process');
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted(), fetch.fetchImpl);
    expect(result).toEqual({ sent: true, reason: 'sent' });
    expect(fetch.seen[0]?.url).toBe(COLLECTOR);
  });

  it('should state in the README the timeout the code uses', async () => {
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
    const section = readme.slice(
      readme.indexOf('### Install count'),
      readme.indexOf('### Processes'),
    );
    expect(section).toContain(`after ${INSTALL_COUNT_TIMEOUT_MS / 1000} seconds`);
  });

  it('should disclose the off switch and the payload fields', async () => {
    const [readme, configuration, security] = await Promise.all([
      readFile(new URL('../../README.md', import.meta.url), 'utf8'),
      readFile(new URL('../../docs/configuration.md', import.meta.url), 'utf8'),
      readFile(new URL('../../SECURITY.md', import.meta.url), 'utf8'),
    ]);
    const start = readme.indexOf('### Install count');
    const end = readme.indexOf('### Processes', start);
    expect(start).toBeGreaterThan(-1);
    const section = readme.slice(start, end);
    expect(section).toContain('The count is off.');
    expect(section).toContain('MAILOO_INSTALL_COUNTER');
    expect(section).toContain('MAILOO_INSTALL_COUNTER_URL');
    expect(section).toContain('`product`');
    expect(section).toContain('`version`');
    expect(section).toContain('`event`');
    expect(section).toContain('`install`');
    expect(section).toContain('`node_major`');
    expect(configuration).toContain('MAILOO_INSTALL_COUNTER');
    expect(configuration).toContain('MAILOO_INSTALL_COUNTER_URL');
    expect(security).toContain('MAILOO_INSTALL_COUNTER');
  });

  it.each([
    'https://collector.example/install?token=abc',
    'https://collector.example/install?',
    'https://collector.example/install#part',
    'https://collector.example/install#',
  ])('should not send to %s, a query or fragment is refused', async (url) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted({ MAILOO_INSTALL_COUNTER_URL: url }), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'rejected' });
    expect(fetch.seen).toHaveLength(0);
  });

  it('should send once when three servers start at the same time on one state dir', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    const env = opted();
    const results = await Promise.all([
      count(dir, env, fetch.fetchImpl),
      count(dir, env, fetch.fetchImpl),
      count(dir, env, fetch.fetchImpl),
    ]);
    expect(fetch.seen).toHaveLength(1);
    expect(results.map((r) => r.reason).sort()).toEqual(['already', 'already', 'sent']);
  });

  it.skipIf(process.getuid?.() === 0)(
    'should send nothing when the state dir is read-only',
    async () => {
      const fetch = recording(204);
      const dir = await stateDir();
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o555);
      expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({
        sent: false,
        reason: 'refused',
      });
      expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({
        sent: false,
        reason: 'refused',
      });
      expect(fetch.seen).toHaveLength(0);
    },
  );

  it('should send nothing when the file system refuses the claim', async () => {
    // EROFS is what a read-only container file system returns, whoever the user is.
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(
      Object.assign(new Error('read-only file system'), { code: 'EROFS' }),
    );
    const fetch = recording(204);
    const dir = await stateDir();
    expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({ sent: false, reason: 'refused' });
    expect(fetch.seen).toHaveLength(0);
  });

  it('should send nothing when a file stands where the state dir should be', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    await writeFile(join(dir, '..', 'blocker'), '');
    const result = await count(join(dir, '..', 'blocker', 'state'), opted(), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'refused' });
    expect(fetch.seen).toHaveLength(0);
  });

  it('should send nothing when the marker cannot be read', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    await mkdir(join(dir, 'install-count'), { recursive: true });
    expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({ sent: false, reason: 'refused' });
    expect(fetch.seen).toHaveLength(0);
    // Refused before any claim: nothing new appears next to the unreadable marker.
    expect(await fs.readdir(dir)).toEqual(['install-count']);
  });

  it('should resolve as refused when the fetch throws', async () => {
    const dir = await stateDir();
    const fetchImpl: InstallCountFetch = async (url) => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    };
    await expect(count(dir, opted(), fetchImpl)).resolves.toEqual({
      sent: false,
      reason: 'refused',
    });
  });

  it('should not send again after a fetch that threw', async () => {
    const dir = await stateDir();
    const throwing: InstallCountFetch = async () => {
      throw new Error('socket hang up');
    };
    await count(dir, opted(), throwing);
    const again = recording(204);
    expect(await count(dir, opted(), again.fetchImpl)).toEqual({ sent: false, reason: 'already' });
    expect(again.seen).toHaveLength(0);
  });

  it('should not send again after a request that timed out', async () => {
    vi.useFakeTimers();
    const dir = await stateDir();
    let reached: () => void = () => {};
    const inFetch = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const hanging: InstallCountFetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        reached();
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const first = count(dir, opted(), hanging);
    await inFetch;
    await vi.advanceTimersByTimeAsync(DOCUMENTED_TIMEOUT_MS);
    expect(await first).toEqual({ sent: false, reason: 'refused' });
    const again = recording(204);
    expect(await count(dir, opted(), again.fetchImpl)).toEqual({ sent: false, reason: 'already' });
    expect(again.seen).toHaveLength(0);
  });

  it('should still report sent when cancelling the response body fails', async () => {
    const dir = await stateDir();
    const fetchImpl: InstallCountFetch = async () => ({
      status: 204,
      body: { cancel: async () => Promise.reject(new Error('stream already closed')) },
    });
    expect(await count(dir, opted(), fetchImpl)).toEqual({ sent: true, reason: 'sent' });
  });

  it('should abort a collector that never answers at the documented bound', async () => {
    vi.useFakeTimers();
    const dir = await stateDir();
    let signal: AbortSignal | undefined;
    let reached: () => void = () => {};
    const inFetch = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const fetchImpl: InstallCountFetch = async (_url, init) => {
      signal = init.signal;
      reached();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    const pending = count(dir, opted(), fetchImpl);
    await inFetch;
    await vi.advanceTimersByTimeAsync(DOCUMENTED_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ sent: false, reason: 'refused' });
  });

  it('should keep the exported timeout at the documented bound', () => {
    expect(INSTALL_COUNT_TIMEOUT_MS).toBe(DOCUMENTED_TIMEOUT_MS);
  });

  it('should leave no timer behind after a fast response', async () => {
    vi.useFakeTimers();
    const fetch = recording(204);
    const dir = await stateDir();
    expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({ sent: true, reason: 'sent' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should not let its timeout keep the process alive', async () => {
    // AbortSignal.timeout does not hold the event loop open; the plain timer that replaced it must not either.
    const timers: ReturnType<typeof setTimeout>[] = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const timer = realSetTimeout(...args);
      timers.push(timer);
      return timer;
    }) as typeof setTimeout);
    let answer: (response: { status: number; body: null }) => void = () => {};
    let reached: () => void = () => {};
    const inFetch = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const fetchImpl: InstallCountFetch = async () =>
      new Promise((resolve) => {
        answer = resolve;
        reached();
      });
    const dir = await stateDir();
    const pending = count(dir, opted(), fetchImpl);
    await inFetch;
    const held = timers.map((timer) => timer.hasRef());
    answer({ status: 204, body: null });
    await pending;
    expect(held).toEqual([false]);
  });

  it('should not open a socket from the test runner when no fetch is injected', async () => {
    // process.env is the runner's here (VITEST is set); the env argument is not.
    const globalFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', globalFetch);
    const dir = await stateDir();
    const result = await recordInstall({
      version: VERSION,
      nodeMajor: NODE_MAJOR,
      env: opted(),
      stateDir: dir,
    });
    expect(result).toEqual({ sent: false, reason: 'refused' });
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe('noteInstall', () => {
  /** The server's own environment: no runner variables, the given counter settings. */
  async function serverStart(counter: Record<string, string>): Promise<{
    stateHome: string;
    noteInstall: (version: string) => Promise<void>;
  }> {
    const stateHome = await stateDir();
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('MAILOO_INSTALL_COUNTER', '');
    vi.stubEnv('MAILOO_INSTALL_COUNTER_URL', '');
    for (const [name, value] of Object.entries(counter)) vi.stubEnv(name, value);
    // xdg.state is read once at import, so the module is loaded after XDG_STATE_HOME is set.
    vi.stubEnv('XDG_STATE_HOME', stateHome);
    vi.stubEnv('XDG_DATA_HOME', join(stateHome, '..', 'data'));
    vi.stubEnv('XDG_CONFIG_HOME', join(stateHome, '..', 'config'));
    vi.resetModules();
    const mod = await import('./install-count.js');
    return { stateHome, noteInstall: mod.noteInstall };
  }

  it('should not call fetch when the switch is off in the process env', async () => {
    const globalFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', globalFetch);
    const { stateHome, noteInstall } = await serverStart({
      MAILOO_INSTALL_COUNTER_URL: COLLECTOR,
    });
    await noteInstall(VERSION);
    expect(globalFetch).not.toHaveBeenCalled();
    await expect(stat(stateHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should post once to the process env URL and record it under XDG_STATE_HOME', async () => {
    const seen: { url: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    });
    const { stateHome, noteInstall } = await serverStart({
      MAILOO_INSTALL_COUNTER: 'on',
      MAILOO_INSTALL_COUNTER_URL: COLLECTOR,
    });
    await noteInstall(VERSION);
    await noteInstall(VERSION);
    expect(seen).toEqual([
      {
        url: COLLECTOR,
        body: {
          product: 'mailoo',
          version: VERSION,
          event: 'install',
          node_major: Number.parseInt(process.versions.node, 10),
        },
      },
    ]);
    expect(await readFile(join(stateHome, 'mailoo', 'install-count'), 'utf8')).toBe('1\n');
  });

  it('should report the major of the running Node.js, not a fixed number', async () => {
    const real = Object.getOwnPropertyDescriptor(process.versions, 'node');
    Object.defineProperty(process.versions, 'node', { ...real, value: '31.4.0' });
    onTestFinished(() => {
      if (real) Object.defineProperty(process.versions, 'node', real);
    });
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    });
    const { noteInstall } = await serverStart({
      MAILOO_INSTALL_COUNTER: '1',
      MAILOO_INSTALL_COUNTER_URL: COLLECTOR,
    });
    await noteInstall(VERSION);
    expect(bodies).toEqual([expect.objectContaining({ node_major: 31 })]);
  });

  it('should cancel a response body the collector keeps open', async () => {
    // A collector that keeps the body open must not hold the socket.
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    const { noteInstall } = await serverStart({
      MAILOO_INSTALL_COUNTER: 'on',
      MAILOO_INSTALL_COUNTER_URL: COLLECTOR,
    });
    await noteInstall(VERSION);
    expect(cancelled).toBe(true);
  });

  it('should resolve when the real fetch rejects', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      throw new TypeError(`fetch failed: ${url}`);
    });
    const { noteInstall } = await serverStart({
      MAILOO_INSTALL_COUNTER: '1',
      MAILOO_INSTALL_COUNTER_URL: COLLECTOR,
    });
    await expect(noteInstall(VERSION)).resolves.toBeUndefined();
  });

  it('should not post again after the real fetch rejected', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url);
      throw new TypeError('fetch failed');
    });
    const { stateHome, noteInstall } = await serverStart({
      MAILOO_INSTALL_COUNTER: '1',
      MAILOO_INSTALL_COUNTER_URL: COLLECTOR,
    });
    await noteInstall(VERSION);
    await noteInstall(VERSION);
    expect(calls).toEqual([COLLECTOR]);
    expect(await readFile(join(stateHome, 'mailoo', 'install-count'), 'utf8')).toBe('1\n');
  });

  it('should hand the real fetch a signal that aborts at the documented bound', async () => {
    let signal: AbortSignal | undefined;
    let reached: () => void = () => {};
    const inFetch = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      reached();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const { noteInstall } = await serverStart({
      MAILOO_INSTALL_COUNTER: '1',
      MAILOO_INSTALL_COUNTER_URL: COLLECTOR,
    });
    vi.useFakeTimers();
    const pending = noteInstall(VERSION);
    await inFetch;
    await vi.advanceTimersByTimeAsync(DOCUMENTED_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(pending).resolves.toBeUndefined();
  });

  it('should be imported by no source file except main.ts', async () => {
    // Derived from the tree, so a new CLI module that imports the counter fails here.
    const srcDir = new URL('../', import.meta.url);
    const files = (await fs.readdir(srcDir, { recursive: true }))
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => !file.endsWith(join('services', 'install-count.ts')));
    const texts = await Promise.all(
      files.map(async (file) => readFile(new URL(file, srcDir), 'utf8')),
    );
    const importers = files.filter((_file, i) => texts[i]?.includes('install-count.js'));
    expect(importers).toEqual(['main.ts']);
  });

  it('should be called only from the stdio and http server starts', async () => {
    // A server start is proven by install-count.entrypoint.test.ts. This pins that no CLI
    // branch of main() calls it too: each call's enclosing function must be a server start.
    const main = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    const callers = [...main.matchAll(/noteInstall\(/g)].map((call) => {
      const before = main.slice(0, call.index);
      const fns = [...before.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)];
      return fns.at(-1)?.[1];
    });
    expect(callers.sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      'runHttpServer',
      'runServer',
    ]);
  });
});
