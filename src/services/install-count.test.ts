/** The runner's CI and VITEST variables are not the operator's env. */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRIVATE_FILE_MODE } from '../utils/atomic-write.js';
import { LOOPBACK_HOSTS_TEXT } from '../utils/loopback.js';
import type {
  InstallCountFetch,
  InstallCountRequest,
  InstallCountResult,
} from './install-count.js';
import {
  INSTALL_COUNT_EVENT,
  INSTALL_COUNT_PRODUCT,
  MARKER_DIGIT,
  MARKER_NAME,
  NEGATIVE_VALUES,
  ON_VALUES,
  recordInstall,
  USER_AGENT,
} from './install-count.js';

const VERSION = '9.9.9';
const NODE_MAJOR = 24;
const COLLECTOR = 'https://collector.example/install';

/** Real time for the collector to see its connection closed after the count resolved. A leak fails the claim instead of waiting out the suite timeout. */
const BODY_RELEASE_WAIT_MS = 2_000;

/** Real time allowed for the count to settle after an abort. A hang fails the claim instead of waiting out the suite timeout. */
const SETTLE_BOUND_MS = 1_000;

/** Root ignores file modes, so a read-only state directory cannot be shown there. */
const RUNS_AS_ROOT = process.getuid?.() === 0;

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

async function firstSend(): Promise<{
  dir: string;
  fetch: ReturnType<typeof recording>;
  result: InstallCountResult;
}> {
  const fetch = recording(204);
  const dir = await stateDir();
  const result = await count(dir, opted(), fetch.fetchImpl);
  return { dir, fetch, result };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe('install count', () => {
  it.each([
    ['unset', {}],
    ['empty', { MAILOO_INSTALL_COUNTER: '' }],
    ...[...NEGATIVE_VALUES].map((value) => [value, { MAILOO_INSTALL_COUNTER: value }] as const),
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

  it.each([...NEGATIVE_VALUES, 'FALSE', ' false ', '', '   '])(
    'should send when CI is the negative %j and the counter is on',
    async (ci) => {
      const fetch = recording(204);
      const dir = await stateDir();
      const result = await count(dir, opted({ CI: ci }), fetch.fetchImpl);
      expect(result).toEqual({ sent: true, reason: 'sent' });
      expect(fetch.seen).toHaveLength(1);
    },
  );

  it('should answer automation, not disabled, when CI is set and the switch is off', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(
      dir,
      { CI: 'true', MAILOO_INSTALL_COUNTER: '0', MAILOO_INSTALL_COUNTER_URL: COLLECTOR },
      fetch.fetchImpl,
    );
    expect(result).toEqual({ sent: false, reason: 'automation' });
  });

  it('should not send when CI names a provider and not a boolean', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted({ CI: 'woodpecker' }), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'automation' });
    expect(fetch.seen).toHaveLength(0);
  });

  it.each([
    ['VITEST', { VITEST: 'true' }],
    ['NODE_ENV=test', { NODE_ENV: 'test' }],
    ['padded NODE_ENV=test', { NODE_ENV: ' test ' }],
  ] as const)('should not send when %s is set', async (_label, extra) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted(extra), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'automation' });
    expect(fetch.seen).toHaveLength(0);
  });

  it.each([
    ['empty VITEST', { VITEST: '' }],
    ['blank VITEST', { VITEST: '  ' }],
    ['production NODE_ENV', { NODE_ENV: 'production' }],
  ] as const)('should send when the env has a %s', async (_label, extra) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted(extra), fetch.fetchImpl);
    expect(result).toEqual({ sent: true, reason: 'sent' });
    expect(fetch.seen).toHaveLength(1);
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
    ['no endpoint', { MAILOO_INSTALL_COUNTER: '1' }, VERSION],
    ['a refused URL', opted({ MAILOO_INSTALL_COUNTER_URL: 'http://collector.example/i' }), VERSION],
    ['a refused version', opted(), 'v1.2.3'],
  ] as const)(
    'should not create the state directory when %s stops the request',
    async (_label, env, version) => {
      const fetch = recording(204);
      const dir = await stateDir();
      await count(dir, env, fetch.fetchImpl, version);
      await expect(stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each([
    'http://collector.example/install',
    'https://user:secret@collector.example/install',
    'https://user@collector.example/install',
    'https://:pw@collector.example/install',
    'ftp://collector.example/install',
    'collector.example/install',
    'https://collector.example/install?token=abc',
    'https://collector.example/install?',
    'https://collector.example/install#part',
    'https://collector.example/install#',
  ])('should not send to %s', async (url) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted({ MAILOO_INSTALL_COUNTER_URL: url }), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'rejected' });
    expect(fetch.seen).toHaveLength(0);
  });

  it('should post to the endpoint without the padding the env value carried', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    const env = opted({ MAILOO_INSTALL_COUNTER_URL: `  ${COLLECTOR}\t` });
    const result = await count(dir, env, fetch.fetchImpl);
    expect(result).toEqual({ sent: true, reason: 'sent' });
    expect(fetch.seen[0]?.url).toBe(COLLECTOR);
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

  it.each([
    'user@example.com',
    '0.2',
    '1.2.3 /home/u',
    '1.2.3-/home/u',
    '1.2.3+user@example.test',
    'v1.2.3',
    '1.2.3-',
    '1.2.3\n',
  ])('should not send when version is %j', async (version) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted(), fetch.fetchImpl, version);
    expect(result).toEqual({ sent: false, reason: 'rejected' });
    expect(fetch.seen).toHaveLength(0);
  });

  it.each(['0.3.0', '0.10.0', '10.20.30', '1.2.3-rc.1', '1.2.3-rc-1', '1.2.3-RC.1', '1.2.3+sha.5'])(
    'should send package version %s as it is',
    async (version) => {
      const fetch = recording(204);
      const dir = await stateDir();
      const result = await count(dir, opted(), fetch.fetchImpl, version);
      expect(result).toEqual({ sent: true, reason: 'sent' });
      expect(JSON.parse(fetch.seen[0]?.init.body ?? '').version).toBe(version);
    },
  );

  it.each([24.5, 100, -1, Number.NaN])(
    'should not send when node major is %s',
    async (nodeMajor) => {
      const fetch = recording(204);
      const dir = await stateDir();
      const result = await count(dir, opted(), fetch.fetchImpl, VERSION, nodeMajor);
      expect(result).toEqual({ sent: false, reason: 'rejected' });
      expect(fetch.seen).toHaveLength(0);
    },
  );

  it.each([0, 99])('should send at the node major bound %s', async (nodeMajor) => {
    const fetch = recording(204);
    const dir = await stateDir();
    const result = await count(dir, opted(), fetch.fetchImpl, VERSION, nodeMajor);
    expect(result).toEqual({ sent: true, reason: 'sent' });
    expect(JSON.parse(fetch.seen[0]?.init.body ?? '').node_major).toBe(nodeMajor);
  });

  it('should post to the named endpoint', async () => {
    const { fetch } = await firstSend();
    expect(fetch.seen[0]?.url).toBe(COLLECTOR);
  });

  it('should pass exactly the six request keys', async () => {
    const { fetch } = await firstSend();
    expect(Object.keys(fetch.seen[0]?.init ?? {}).sort()).toEqual(
      ['body', 'credentials', 'headers', 'method', 'redirect', 'signal'].sort(),
    );
  });

  it.each([
    ['method', 'POST'],
    ['redirect', 'manual'],
    ['credentials', 'omit'],
  ] as const)('should set the request %s to %s', async (key, value) => {
    const { fetch } = await firstSend();
    expect(fetch.seen[0]?.init[key]).toBe(value);
  });

  it('should send the content-type and user-agent headers', async () => {
    const { fetch } = await firstSend();
    expect(fetch.seen[0]?.init.headers).toEqual({
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    });
  });

  it('should send exactly one request on the first start', async () => {
    const { fetch, result } = await firstSend();
    expect(result).toEqual({ sent: true, reason: 'sent' });
    expect(fetch.seen).toHaveLength(1);
  });

  it('should post exactly the four install field names', async () => {
    const { fetch } = await firstSend();
    expect(Object.keys(JSON.parse(fetch.seen[0]?.init.body ?? '')).sort()).toEqual([
      'event',
      'node_major',
      'product',
      'version',
    ]);
  });

  it.each([
    ['product', 'mailoo'],
    ['version', VERSION],
    ['event', 'install'],
    ['node_major', NODE_MAJOR],
  ] as const)('should post %s as %j', async (field, value) => {
    const { fetch } = await firstSend();
    expect(JSON.parse(fetch.seen[0]?.init.body ?? '')[field]).toBe(value);
  });

  it('should write the marker digit and a newline', async () => {
    const { dir } = await firstSend();
    expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe('1\n');
  });

  it('should keep the marker private to the owner', async () => {
    // The mode is masked by the umask: under 077 a 0o644 request would also read back 0o600.
    const previous = process.umask(0o022);
    onTestFinished(() => {
      process.umask(previous);
    });
    const { dir } = await firstSend();
    const info = await stat(join(dir, 'install-count'));
    // Permission bits only; the high bits are the file type.
    // eslint-disable-next-line no-bitwise
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('should create missing parent directories for the marker', async () => {
    const fetch = recording(204);
    const root = await mkdtemp(join(tmpdir(), 'mailoo-install-count-'));
    roots.push(root);
    const dir = join(root, 'absent', 'deeper', 'state');
    const result = await count(dir, opted(), fetch.fetchImpl);
    expect(result).toEqual({ sent: true, reason: 'sent' });
    expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe('1\n');
  });

  it.each([200, 204, 299])(
    'should record the install when the collector answers %s',
    async (status) => {
      const fetch = recording(status);
      const dir = await stateDir();
      expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({ sent: true, reason: 'sent' });
      expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe('1\n');
    },
  );

  it.each([0, 199, 300, 302, 404, 503])(
    'should report refused and keep the marker when the collector answers %s',
    async (status) => {
      const fetch = recording(status);
      const dir = await stateDir();
      expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({
        sent: false,
        reason: 'refused',
      });
      expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe('1\n');
    },
  );

  it('should resolve refused and keep the marker when the fetch throws', async () => {
    const dir = await stateDir();
    const throwing: InstallCountFetch = async () => {
      throw new Error(`connect ECONNREFUSED ${COLLECTOR}`);
    };
    const result = await count(dir, opted(), throwing);
    expect(result).toEqual({ sent: false, reason: 'refused' });
    expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe('1\n');
  });

  it.each([204, 503])('should release the response body after a %s answer', async (status) => {
    const dir = await stateDir();
    let released = false;
    const fetchImpl: InstallCountFetch = async () => ({
      status,
      body: {
        cancel: async () => {
          released = true;
        },
      },
    });
    await count(dir, opted(), fetchImpl);
    expect(released).toBe(true);
  });

  it('should record the install when releasing the response body fails', async () => {
    const dir = await stateDir();
    const fetchImpl: InstallCountFetch = async () => ({
      status: 204,
      body: {
        cancel: async () => {
          throw new Error('stream already closed');
        },
      },
    });
    expect(await count(dir, opted(), fetchImpl)).toEqual({ sent: true, reason: 'sent' });
    expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe('1\n');
  });

  it('should abandon a collector that has not answered after 3000 ms', async () => {
    // Node's AbortSignal.timeout runs on internal timers that fake timers do not reach.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, ms);
      return controller.signal;
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = await stateDir();
    let started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hung: InstallCountFetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
        started();
      });
    let settled: InstallCountResult | undefined;
    const pending = count(dir, opted(), hung).then((result) => {
      settled = result;
    });
    await requested;
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    // Neither setImmediate nor Date is faked, so the result is read once it settles or after this
    // real-time bound, never by advancing the fake clock past a later timeout.
    const readyBy = Date.now() + SETTLE_BOUND_MS;
    while (settled === undefined && Date.now() < readyBy) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
    expect(settled).toEqual({ sent: false, reason: 'refused' });
    await pending;
  });

  describe('claim on the state directory', () => {
    it('should send once and answer already to a start that overlaps the first', async () => {
      const dir = await stateDir();
      let requests = 0;
      let inFlight!: () => void;
      const firstIsPosting = new Promise<void>((resolve) => {
        inFlight = resolve;
      });
      let answer!: () => void;
      const gate = new Promise<void>((resolve) => {
        answer = resolve;
      });
      const holdingFetch: InstallCountFetch = async () => {
        requests += 1;
        inFlight();
        await gate;
        return { status: 204, body: null };
      };
      const first = count(dir, opted(), holdingFetch);
      await firstIsPosting;
      const second = await count(dir, opted(), holdingFetch);
      answer();
      expect(await first).toEqual({ sent: true, reason: 'sent' });
      expect(second).toEqual({ sent: false, reason: 'already' });
      expect(requests).toBe(1);
    });

    it('should send once between three starts that begin together', async () => {
      const fetch = recording(204);
      const dir = await stateDir();
      const results = await Promise.all(
        [1, 2, 3].map(async () => count(dir, opted(), fetch.fetchImpl)),
      );
      expect(results.filter((result) => result.sent)).toHaveLength(1);
      expect(fetch.seen).toHaveLength(1);
    });

    it('should hold the marker before the request goes out', async () => {
      const dir = await stateDir();
      let atRequest: string | undefined;
      const peeking: InstallCountFetch = async () => {
        atRequest = await readFile(join(dir, 'install-count'), 'utf8');
        return { status: 204, body: null };
      };
      await count(dir, opted(), peeking);
      expect(atRequest).toBe('1\n');
    });

    it.each([
      ['a refusing collector', async () => recording(503).fetchImpl],
      ['a redirect', async () => recording(302).fetchImpl],
      [
        'a fetch that throws',
        async () => {
          const throwing: InstallCountFetch = async () => {
            throw new Error('connect ECONNREFUSED');
          };
          return throwing;
        },
      ],
    ] as const)('should not send on a later start after %s', async (_label, build) => {
      const dir = await stateDir();
      expect(await count(dir, opted(), await build())).toEqual({ sent: false, reason: 'refused' });
      const next = recording(204);
      expect(await count(dir, opted(), next.fetchImpl)).toEqual({
        sent: false,
        reason: 'already',
      });
      expect(next.seen).toHaveLength(0);
    });

    it.each(['', '0\n', '2\n', 'not a count'])(
      'should leave a marker holding %j as it is and not send',
      async (text) => {
        const fetch = recording(204);
        const dir = await stateDir();
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'install-count'), text);
        expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({
          sent: false,
          reason: 'already',
        });
        expect(fetch.seen).toHaveLength(0);
        expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe(text);
      },
    );

    it('should not send when a directory sits at the marker path', async () => {
      const fetch = recording(204);
      const dir = await stateDir();
      await mkdir(join(dir, 'install-count'), { recursive: true });
      expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({
        sent: false,
        reason: 'already',
      });
      expect(fetch.seen).toHaveLength(0);
      expect((await stat(join(dir, 'install-count'))).isDirectory()).toBe(true);
    });

    it.skipIf(RUNS_AS_ROOT)(
      'should send nothing from a state directory it cannot write, on this start or the next',
      async () => {
        const fetch = recording(204);
        const dir = await stateDir();
        await mkdir(dir, { recursive: true });
        // Nothing can be created in it, so the empty directory is still removed after the test.
        await chmod(dir, 0o500);
        expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({
          sent: false,
          reason: 'refused',
        });
        expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({
          sent: false,
          reason: 'refused',
        });
        expect(fetch.seen).toHaveLength(0);
        await expect(stat(join(dir, 'install-count'))).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
  });

  it('should not send again once the marker exists', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    const env = opted();
    expect(await count(dir, env, fetch.fetchImpl)).toEqual({ sent: true, reason: 'sent' });
    expect(await count(dir, env, fetch.fetchImpl)).toEqual({ sent: false, reason: 'already' });
    expect(fetch.seen).toHaveLength(1);
  });

  it('should not follow a redirect', async () => {
    const fetch = recording(302);
    const dir = await stateDir();
    const result = await count(dir, opted(), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'refused' });
    expect(fetch.seen).toHaveLength(1);
    expect(fetch.seen[0]?.init.redirect).toBe('manual');
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

  // Each doc test binds one sentence to values the code owns, so a wrong value or an inverted verb fails.
  // Prose with no value in the code (other commands do not send, redirects, userinfo) is owned by the
  // code tests, not here.
  const CASE_NOTE = 'any letter case, surrounding spaces ignored';

  function codes(values: Iterable<string>): string {
    return [...values].map((value) => `\`${value}\``).join(', ');
  }

  function list(values: Iterable<string>): string {
    const items = [...values].map((value) => `\`${value}\``);
    return `${items.slice(0, -1).join(', ')}, or ${items.at(-1)}`;
  }

  const MODE_TEXT = PRIVATE_FILE_MODE.toString(8).padStart(4, '0');
  const LOOPBACK_FORMS = LOOPBACK_HOSTS_TEXT.split(/,\s*|\s+or\s+/);

  const ON_CLAUSE = `\`MAILOO_INSTALL_COUNTER\` is ${list(ON_VALUES)} (${CASE_NOTE})`;
  const CI_CLAUSE = `The count is skipped when \`CI\` is non-blank and not ${list(NEGATIVE_VALUES)} in any letter case`;

  async function document(target: string): Promise<string> {
    return readFile(new URL(target, import.meta.url), 'utf8');
  }

  async function lineStarting(file: string, prefix: string): Promise<string> {
    const line = (await document(file)).split('\n').find((text) => text.startsWith(prefix));
    expect(line, `${file} has a line starting ${prefix}`).toBeDefined();
    return line ?? '';
  }

  async function lineContaining(file: string, needle: string): Promise<string> {
    const line = (await document(file)).split('\n').find((text) => text.includes(needle));
    expect(line, `${file} has a line containing ${needle}`).toBeDefined();
    return line ?? '';
  }

  async function readmeInstallCount(): Promise<string> {
    const readme = await document('../../README.md');
    const start = readme.indexOf('### Install count');
    expect(start).toBeGreaterThan(-1);
    return readme.slice(start, readme.indexOf('### Processes', start));
  }

  async function sentFields(): Promise<string[]> {
    const { fetch } = await firstSend();
    return Object.keys(JSON.parse(fetch.seen[0]?.init.body ?? '{}'));
  }

  function fieldsClause(fields: string[]): string {
    const items = fields.map((field) => {
      if (field === 'event') return `\`event\` (\`${INSTALL_COUNT_EVENT}\`)`;
      return `\`${field}\``;
    });
    return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
  }

  it('should list in the README summary the fields the request posts', async () => {
    const line = await lineContaining('../../README.md', 'An install count stays off');
    expect(line).toContain(`The POST body is only ${fieldsClause(await sentFields())}.`);
  });

  it('should list in SECURITY.md the fields the request posts', async () => {
    const line = await lineContaining('../../SECURITY.md', '**Install count**');
    expect(line).toContain(`POSTs ${fieldsClause(await sentFields())} (`);
  });

  it('should list in the README payload table exactly the fields the request posts', async () => {
    const lines = (await readmeInstallCount()).split('\n');
    const header = lines.indexOf('| Field | Value |');
    expect(header).toBeGreaterThan(-1);
    const end = lines.findIndex((line, index) => index > header && !line.startsWith('|'));
    const names = lines.slice(header + 2, end).map((row) => /^\| `([^`]+)` \|/.exec(row)?.[1]);
    expect(names).toEqual(await sentFields());
  });

  it('should declare no script npm runs when the package is installed from the registry', async () => {
    const manifest = JSON.parse(await document('../../package.json')) as {
      scripts: Record<string, string>;
    };
    const hooks = ['preinstall', 'install', 'postinstall'].filter(
      (name) => name in manifest.scripts,
    );
    expect(hooks).toEqual([]);
  });

  it('should say in the README summary which values opt in', async () => {
    const line = await lineContaining('../../README.md', 'An install count stays off');
    expect(line).toContain(`${ON_CLAUSE} and \`MAILOO_INSTALL_COUNTER_URL\` is set`);
  });

  it('should say in the README summary which values keep the count off', async () => {
    const line = await lineContaining('../../README.md', 'An install count stays off');
    expect(line).toContain(`Unset, ${list(NEGATIVE_VALUES)} keeps it off`);
  });

  it('should say in the README section which values opt in', async () => {
    expect(await readmeInstallCount()).toContain(`- ${ON_CLAUSE}\n`);
  });

  it('should say in the README section which values keep the count off', async () => {
    expect(await readmeInstallCount()).toContain(
      `${codes(NEGATIVE_VALUES)}, or an unset \`MAILOO_INSTALL_COUNTER\` keeps the count off`,
    );
  });

  it('should say in the README section which CI values skip the count', async () => {
    expect(await readmeInstallCount()).toContain(CI_CLAUSE);
  });

  it('should say in the README section which URLs are refused', async () => {
    expect(await readmeInstallCount()).toContain(
      `\`http\` is refused except for ${list(LOOPBACK_FORMS)}. Any other URL must be \`https\`.`,
    );
  });

  it.each([
    ['product', INSTALL_COUNT_PRODUCT],
    ['event', INSTALL_COUNT_EVENT],
  ])('should give the README payload table the %s value the code posts', async (field, value) => {
    expect(await readmeInstallCount()).toContain(`| \`${field}\` | \`${value}\` |`);
  });

  it('should give the README the headers the request carries', async () => {
    const { fetch } = await firstSend();
    const headers = fetch.seen[0]?.init.headers;
    expect(await readmeInstallCount()).toContain(
      `Request headers are \`content-type: ${headers?.['content-type']}\` and \`user-agent: ${headers?.['user-agent']}\`.`,
    );
  });

  it('should say in the README which file the count creates before the request', async () => {
    expect(await readmeInstallCount()).toContain(
      `the server creates \`$XDG_STATE_HOME/mailoo/${MARKER_NAME}\` (mode \`${MODE_TEXT}\`) containing the digit \`${MARKER_DIGIT}\` and nothing else`,
    );
  });

  it('should say in the README files table which file and mode the count uses', async () => {
    const row = await lineStarting('../../README.md', '| `$XDG_STATE_HOME/mailoo/install-count`');
    expect(row).toContain(`| \`$XDG_STATE_HOME/mailoo/${MARKER_NAME}\` (mode \`${MODE_TEXT}\`) |`);
  });

  it('should say in the README files table what the marker holds', async () => {
    const row = await lineStarting('../../README.md', '| `$XDG_STATE_HOME/mailoo/install-count`');
    expect(row).toContain(
      `| The digit \`${MARKER_DIGIT}\`, written before the install count request and kept whatever the answer.`,
    );
  });

  it('should say in the README env table which values opt in', async () => {
    const row = await lineStarting('../../README.md', '| `MAILOO_INSTALL_COUNTER` |');
    expect(row).toContain(`${list(ON_VALUES)} opts in (${CASE_NOTE})`);
  });

  it('should say in the README env table which values force the count off', async () => {
    const row = await lineStarting('../../README.md', '| `MAILOO_INSTALL_COUNTER` |');
    expect(row).toContain(`${list(NEGATIVE_VALUES)} forces it off`);
  });

  it('should say in docs/configuration.md which values opt in', async () => {
    const row = await lineStarting('../../docs/configuration.md', '| `MAILOO_INSTALL_COUNTER` |');
    expect(row).toContain(`${list(ON_VALUES)} opts in to the install count (${CASE_NOTE})`);
  });

  it('should say in docs/configuration.md which values keep the count off', async () => {
    const row = await lineStarting('../../docs/configuration.md', '| `MAILOO_INSTALL_COUNTER` |');
    expect(row).toContain(`${codes(NEGATIVE_VALUES)}, or any other value keeps it off`);
  });

  it('should say in docs/configuration.md which URLs are accepted', async () => {
    const row = await lineStarting(
      '../../docs/configuration.md',
      '| `MAILOO_INSTALL_COUNTER_URL` |',
    );
    expect(row).toContain(`\`https\` URL that receives one install POST`);
    expect(row).toContain(`\`http\` only for ${list(LOOPBACK_FORMS)}`);
  });

  it('should say in SECURITY.md which values opt in', async () => {
    expect(await lineContaining('../../SECURITY.md', '**Install count**')).toContain(ON_CLAUSE);
  });

  it('should say in SECURITY.md which values force the count off', async () => {
    const line = await lineContaining('../../SECURITY.md', '**Install count**');
    expect(line).toContain(`${list(NEGATIVE_VALUES)} forces it off`);
  });

  it('should say in SECURITY.md which CI values skip the count', async () => {
    const line = await lineContaining('../../SECURITY.md', '**Install count**');
    expect(line).toContain(CI_CLAUSE);
  });
});

describe('install count through the process environment and the global fetch', () => {
  interface Captured {
    url: string;
    init: RequestInit;
  }

  /**
   * Pins what the real entry reads: the runner's own VITEST, NODE_ENV and CI
   * are removed, HOME and the XDG dirs point into a tmpdir, and the global
   * fetch is a recorder. xdg.state is fixed when the module loads, so the
   * module is imported after the stubs.
   */
  async function processBound(
    answer: (() => Promise<Response>) | undefined,
    env: Record<string, string | undefined> = {},
  ): Promise<{
    noteInstall: (version: string) => Promise<void>;
    recordInstall: typeof recordInstall;
    marker: string;
    calls: Captured[];
  }> {
    const root = await mkdtemp(join(tmpdir(), 'mailoo-install-count-'));
    roots.push(root);
    const calls: Captured[] = [];
    if (answer !== undefined) {
      vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return answer();
      });
    }
    vi.stubEnv('HOME', root);
    vi.stubEnv('XDG_STATE_HOME', join(root, 'state'));
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
    vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
    vi.stubEnv('VITEST', undefined);
    vi.stubEnv('NODE_ENV', undefined);
    vi.stubEnv('CI', undefined);
    const merged = { ...opted(), ...env };
    Object.entries(merged).forEach(([name, value]) => {
      vi.stubEnv(name, value);
    });
    vi.resetModules();
    const mod = await import('./install-count.js');
    return {
      noteInstall: mod.noteInstall,
      recordInstall: mod.recordInstall,
      marker: join(root, 'state', 'mailoo', 'install-count'),
      calls,
    };
  }

  it('should send this process version and Node major and record the marker', async () => {
    const bound = await processBound(async () => new Response(null, { status: 204 }));
    await bound.noteInstall(VERSION);
    expect(bound.calls).toHaveLength(1);
    expect(bound.calls[0]?.url).toBe(COLLECTOR);
    expect(JSON.parse(String(bound.calls[0]?.init.body))).toEqual({
      product: 'mailoo',
      version: VERSION,
      event: 'install',
      node_major: Number(process.versions.node.split('.')[0]),
    });
    expect(await readFile(bound.marker, 'utf8')).toBe('1\n');
  });

  it('should not send from the process environment when the counter is off', async () => {
    const bound = await processBound(async () => new Response(null, { status: 204 }), {
      MAILOO_INSTALL_COUNTER: undefined,
    });
    await bound.noteInstall(VERSION);
    expect(bound.calls).toHaveLength(0);
    await expect(stat(bound.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should not send from the process environment when CI is set', async () => {
    const bound = await processBound(async () => new Response(null, { status: 204 }), {
      CI: 'true',
    });
    await bound.noteInstall(VERSION);
    expect(bound.calls).toHaveLength(0);
    await expect(stat(bound.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should pass the request flags to the global fetch', async () => {
    const bound = await processBound(async () => new Response(null, { status: 204 }));
    await bound.noteInstall(VERSION);
    const init = bound.calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(init?.credentials).toBe('omit');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('should resolve and keep the marker when the global fetch rejects', async () => {
    const bound = await processBound(async () => {
      throw new TypeError(`fetch failed ${COLLECTOR}`);
    });
    await expect(bound.noteInstall(VERSION)).resolves.toBeUndefined();
    expect(bound.calls).toHaveLength(1);
    expect(await readFile(bound.marker, 'utf8')).toBe('1\n');
  });

  it('should not post again after the global fetch answered 503', async () => {
    const bound = await processBound(async () => new Response('busy', { status: 503 }));
    await bound.noteInstall(VERSION);
    await bound.noteInstall(VERSION);
    expect(bound.calls).toHaveLength(1);
  });

  it('should not reach a socket when the process is the test runner', async () => {
    const bound = await processBound(async () => new Response(null, { status: 204 }));
    vi.stubEnv('VITEST', 'true');
    const dir = await stateDir();
    const result = await bound.recordInstall({
      version: VERSION,
      nodeMajor: NODE_MAJOR,
      env: opted(),
      stateDir: dir,
    });
    expect(result).toEqual({ sent: false, reason: 'refused' });
    expect(bound.calls).toHaveLength(0);
  });

  interface Loopback {
    url: string;
    hits: string[];
  }

  async function loopback(status: number, location?: string): Promise<Loopback> {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.statusCode = status;
      if (location !== undefined) res.setHeader('location', location);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    onTestFinished(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { url: `http://127.0.0.1:${port}/install`, hits };
  }

  it.each([200, 503])(
    'should close the connection to a collector that answers %s and keeps its body open',
    async (status) => {
      let closed = false;
      const server = http.createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'text/plain' });
        res.write('partial');
        res.on('close', () => {
          closed = true;
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      onTestFinished(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const bound = await processBound(undefined, {
        MAILOO_INSTALL_COUNTER_URL: `http://127.0.0.1:${port}/install`,
      });
      await bound.noteInstall(VERSION);
      await vi.waitFor(() => expect(closed).toBe(true), {
        timeout: BODY_RELEASE_WAIT_MS,
        interval: 20,
      });
    },
  );

  it('should not follow a redirect to a second server through the real fetch', async () => {
    const second = await loopback(204);
    const first = await loopback(302, second.url);
    const bound = await processBound(undefined, { MAILOO_INSTALL_COUNTER_URL: first.url });
    await bound.noteInstall(VERSION);
    expect(first.hits).toEqual(['POST /install']);
    expect(second.hits).toEqual([]);
  });
});
