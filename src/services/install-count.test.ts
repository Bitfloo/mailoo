/** The runner's CI and VITEST variables are not the operator's env. */

import fsPromises, {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  InstallCountFetch,
  InstallCountRequest,
  InstallCountResult,
} from './install-count.js';
import {
  INSTALL_COUNT_CLAIM_STALE_MS,
  INSTALL_COUNT_TIMEOUT_MS,
  ON_VALUES,
  recordInstall,
} from './install-count.js';

const VERSION = '9.9.9';
const NODE_MAJOR = 24;
const COLLECTOR = 'https://collector.example/install';

/** The words README and SECURITY.md give as turning the count off, and as CI values that do not skip it. */
const NEGATIVE_WORDS = ['0', 'false', 'no', 'off'];

/** Real time allowed for the lock release that follows an abort. A hang fails the claim instead of waiting out the suite timeout. */
const SETTLE_BOUND_MS = 1_000;

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

  it.each([...NEGATIVE_WORDS, 'FALSE', ' false ', '', '   '])(
    'should send when CI is the negative %j and the counter is on',
    async (ci) => {
      const fetch = recording(204);
      const dir = await stateDir();
      const result = await count(dir, opted({ CI: ci }), fetch.fetchImpl);
      expect(result).toEqual({ sent: true, reason: 'sent' });
      expect(fetch.seen).toHaveLength(1);
    },
  );

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
    'http://collector.example/install',
    'https://user:secret@collector.example/install',
    'https://user@collector.example/install',
    'https://:pw@collector.example/install',
    'ftp://collector.example/install',
    'collector.example/install',
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

  it.each(['user@example.com', '0.2', '1.2.3 /home/u', 'v1.2.3', '1.2.3-', '1.2.3\n'])(
    'should not send when version is %j',
    async (version) => {
      const fetch = recording(204);
      const dir = await stateDir();
      const result = await count(dir, opted(), fetch.fetchImpl, version);
      expect(result).toEqual({ sent: false, reason: 'rejected' });
      expect(fetch.seen).toHaveLength(0);
    },
  );

  it.each(['0.3.0', '1.2.3-rc.1', '1.2.3+sha.5'])(
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

  it('should post to the named endpoint with fixed request flags', async () => {
    const { fetch } = await firstSend();
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
  });

  it('should post only the four install fields', async () => {
    const { fetch, result } = await firstSend();
    expect(result).toEqual({ sent: true, reason: 'sent' });
    expect(fetch.seen).toHaveLength(1);
    expect(JSON.parse(fetch.seen[0]?.init.body ?? '')).toEqual({
      product: 'mailoo',
      version: VERSION,
      event: 'install',
      node_major: NODE_MAJOR,
    });
  });

  it('should record the generation after the collector accepted', async () => {
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
    'should not record the install when the collector answers %s',
    async (status) => {
      const fetch = recording(status);
      const dir = await stateDir();
      expect(await count(dir, opted(), fetch.fetchImpl)).toEqual({
        sent: false,
        reason: 'refused',
      });
      await expect(stat(join(dir, 'install-count'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('should refuse without sending when the marker cannot be read', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    await mkdir(join(dir, 'install-count'), { recursive: true });
    const result = await count(dir, opted(), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'refused' });
    expect(fetch.seen).toHaveLength(0);
  });

  it('should resolve refused and write no marker when the fetch throws', async () => {
    const dir = await stateDir();
    const throwing: InstallCountFetch = async () => {
      throw new Error(`connect ECONNREFUSED ${COLLECTOR}`);
    };
    const result = await count(dir, opted(), throwing);
    expect(result).toEqual({ sent: false, reason: 'refused' });
    await expect(stat(join(dir, 'install-count'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should release the response body after the answer', async () => {
    const dir = await stateDir();
    let released = false;
    const fetchImpl: InstallCountFetch = async () => ({
      status: 204,
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
    // Neither setImmediate nor Date is faked. Releasing the lock takes real file I/O after the abort,
    // so the result is read once it settles or after this real-time bound, never by advancing the fake clock.
    const readyBy = Date.now() + SETTLE_BOUND_MS;
    while (settled === undefined && Date.now() < readyBy) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    }
    expect(settled).toEqual({ sent: false, reason: 'refused' });
    await pending;
    await expect(stat(join(dir, 'install-count'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  describe('claim on the state directory', () => {
    const FOREIGN_TOKEN = 'token-of-another-process';

    function lockOf(dir: string): string {
      return join(dir, 'install-count.lock');
    }

    async function foreignLock(dir: string, ageMs: number): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(lockOf(dir), FOREIGN_TOKEN);
      const then = new Date(Date.now() - ageMs);
      await utimes(lockOf(dir), then, then);
    }

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

    it('should answer already and leave the lock alone when another process holds it', async () => {
      const fetch = recording(204);
      const dir = await stateDir();
      await foreignLock(dir, 0);
      const result = await count(dir, opted(), fetch.fetchImpl);
      expect(result).toEqual({ sent: false, reason: 'already' });
      expect(fetch.seen).toHaveLength(0);
      expect(await readFile(lockOf(dir), 'utf8')).toBe(FOREIGN_TOKEN);
      await expect(stat(join(dir, 'install-count'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('should not take a lock whose holder is still inside its fetch timeout', async () => {
      const fetch = recording(204);
      const dir = await stateDir();
      // A live holder can be at the very end of its fetch timeout, plus the marker write.
      await foreignLock(dir, INSTALL_COUNT_TIMEOUT_MS + 1_000);
      const result = await count(dir, opted(), fetch.fetchImpl);
      expect(result).toEqual({ sent: false, reason: 'already' });
      expect(fetch.seen).toHaveLength(0);
    });

    it('should send when the lock is older than the stale window', async () => {
      const fetch = recording(204);
      const dir = await stateDir();
      await foreignLock(dir, INSTALL_COUNT_CLAIM_STALE_MS + 1_000);
      const result = await count(dir, opted(), fetch.fetchImpl);
      expect(result).toEqual({ sent: true, reason: 'sent' });
      expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe('1\n');
    });

    it('should send once when another start finishes between its marker read and its claim', async () => {
      const dir = await stateDir();
      const markerFile = join(dir, 'install-count');
      const fetch = recording(204);
      let other: Promise<InstallCountResult> | undefined;
      // The only way to force this interleaving: run the other start right after the first marker read.
      const realRead = fsPromises.readFile.bind(fsPromises);
      const runOther = async (path: unknown): Promise<void> => {
        if (path !== markerFile || other !== undefined) return;
        other = count(dir, opted(), fetch.fetchImpl);
        await other;
      };
      vi.spyOn(fsPromises, 'readFile').mockImplementation(async (...args) => {
        try {
          const result = await realRead(...args);
          await runOther(args[0]);
          return result;
        } catch (err) {
          await runOther(args[0]);
          throw err;
        }
      });
      const first = await count(dir, opted(), fetch.fetchImpl);
      const second = await other;
      expect([first, second].filter((result) => result?.sent)).toHaveLength(1);
      expect(fetch.seen).toHaveLength(1);
    });

    it('should leave no lock after a recorded install', async () => {
      const { dir } = await firstSend();
      await expect(stat(lockOf(dir))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each([
      ['a refusing collector', async () => recording(500).fetchImpl, false],
      [
        'a fetch that throws',
        async () => {
          const throwing: InstallCountFetch = async () => {
            throw new Error('connect ECONNREFUSED');
          };
          return throwing;
        },
        false,
      ],
      ['an unreadable marker', async () => recording(204).fetchImpl, true],
    ] as const)('should leave no lock after %s', async (_label, build, markerIsDir) => {
      const dir = await stateDir();
      if (markerIsDir) await mkdir(join(dir, 'install-count'), { recursive: true });
      await count(dir, opted(), await build());
      await expect(stat(lockOf(dir))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it.each([
      ['a refusing collector', 500],
      ['a fetch that throws', 'throw'],
    ] as const)('should send on the next start after %s', async (_label, first) => {
      const dir = await stateDir();
      const failing: InstallCountFetch =
        first === 'throw'
          ? async () => {
              throw new Error('connect ECONNREFUSED');
            }
          : recording(first).fetchImpl;
      await count(dir, opted(), failing);
      const next = recording(204);
      expect(await count(dir, opted(), next.fetchImpl)).toEqual({ sent: true, reason: 'sent' });
      expect(next.seen).toHaveLength(1);
    });

    it('should record the install when the lock cannot be released afterwards', async () => {
      const dir = await stateDir();
      // A directory in place of the lock makes the release read fail with EISDIR.
      const swapLock: InstallCountFetch = async () => {
        await rm(lockOf(dir));
        await mkdir(lockOf(dir));
        return { status: 204, body: null };
      };
      expect(await count(dir, opted(), swapLock)).toEqual({ sent: true, reason: 'sent' });
      expect(await readFile(join(dir, 'install-count'), 'utf8')).toBe('1\n');
    });
  });

  it('should not send again after that generation is recorded', async () => {
    const fetch = recording(204);
    const dir = await stateDir();
    const env = opted();
    expect(await count(dir, env, fetch.fetchImpl)).toEqual({ sent: true, reason: 'sent' });
    expect(await count(dir, env, fetch.fetchImpl)).toEqual({ sent: false, reason: 'already' });
    expect(fetch.seen).toHaveLength(1);
  });

  it('should send on a later start when the collector did not accept', async () => {
    const fetch = recording(503);
    const dir = await stateDir();
    const env = opted();
    expect(await count(dir, env, fetch.fetchImpl)).toEqual({ sent: false, reason: 'refused' });
    await expect(stat(join(dir, 'install-count'))).rejects.toMatchObject({ code: 'ENOENT' });
    const again = recording(204);
    expect(await count(dir, env, again.fetchImpl)).toEqual({ sent: true, reason: 'sent' });
    expect(again.seen).toHaveLength(1);
  });

  it('should not follow a redirect or record it', async () => {
    const fetch = recording(302);
    const dir = await stateDir();
    const result = await count(dir, opted(), fetch.fetchImpl);
    expect(result).toEqual({ sent: false, reason: 'refused' });
    expect(fetch.seen).toHaveLength(1);
    expect(fetch.seen[0]?.init.redirect).toBe('manual');
    await expect(stat(join(dir, 'install-count'))).rejects.toMatchObject({ code: 'ENOENT' });
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

  async function document(relative: string): Promise<string> {
    return readFile(new URL(relative, import.meta.url), 'utf8');
  }

  async function readmeInstallCount(): Promise<string> {
    const readme = await document('../../README.md');
    const start = readme.indexOf('### Install count');
    expect(start).toBeGreaterThan(-1);
    return readme.slice(start, readme.indexOf('### Processes', start));
  }

  const PRIVACY_NOUNS = [
    'email address',
    'account name',
    'password',
    'token',
    'mail-server hostname',
    'message id',
    'folder name',
    'machine id',
    'operating-system username',
    'home directory',
    'working directory',
    'IP address',
  ];
  const LOOPBACK_FORMS = ['localhost', '127.0.0.0/8', '::1'];

  async function readmeCiParagraph(): Promise<string> {
    const section = await readmeInstallCount();
    const start = section.indexOf('The count is skipped when');
    expect(start).toBeGreaterThan(-1);
    return section.slice(start, section.indexOf('\n', start));
  }

  async function securityInstallCount(): Promise<string> {
    const security = await document('../../SECURITY.md');
    const line = security.split('\n').find((text) => text.includes('**Install count**'));
    expect(line).toBeDefined();
    return line ?? '';
  }

  it('should say in the README that the count is off', async () => {
    expect(await readmeInstallCount()).toContain('The count is off.');
  });

  it.each(['MAILOO_INSTALL_COUNTER', 'MAILOO_INSTALL_COUNTER_URL'])(
    'should name %s in the README install count section',
    async (name) => {
      expect(await readmeInstallCount()).toContain(`\`${name}\``);
    },
  );

  it.each(['product', 'version', 'event', 'install', 'node_major'])(
    'should list the payload word %s in the README install count section',
    async (word) => {
      expect(await readmeInstallCount()).toContain(`\`${word}\``);
    },
  );

  it.each([...ON_VALUES])('should list the on value %s in the README', async (value) => {
    expect(await readmeInstallCount()).toContain(`\`${value}\``);
  });

  it.each(NEGATIVE_WORDS)(
    'should list %s among the values the README says keep the count off',
    async (word) => {
      const section = await readmeInstallCount();
      const end = section.indexOf('keeps the count off');
      expect(end).toBeGreaterThan(-1);
      expect(section.slice(section.lastIndexOf('\n\n', end), end)).toContain(`\`${word}\``);
    },
  );

  it.each(NEGATIVE_WORDS)(
    'should list %s as a CI value that does not skip the count in the README',
    async (word) => {
      expect(await readmeCiParagraph()).toContain(`\`${word}\``);
    },
  );

  it.each(['`CI` is non-blank', 'in any letter case', '`VITEST` non-blank', '`NODE_ENV=test`'])(
    'should say in the README what skips the count: %s',
    async (clause) => {
      expect(await readmeCiParagraph()).toContain(clause);
    },
  );

  it('should say in the README that the body never includes mail or machine data', async () => {
    expect(await readmeInstallCount()).toContain('The body never includes');
  });

  it.each(PRIVACY_NOUNS)(
    'should list %s among what the README says the body never includes',
    async (noun) => {
      const section = await readmeInstallCount();
      const promise = section.slice(section.indexOf('The body never includes'));
      expect(promise).toContain(noun);
    },
  );

  it('should say in the README that a non-loopback URL must be https', async () => {
    expect(await readmeInstallCount()).toContain('Any other URL must be `https`');
  });

  it.each(LOOPBACK_FORMS)('should name the loopback form %s in the README', async (form) => {
    expect(await readmeInstallCount()).toContain(`\`${form}\``);
  });

  it('should say in the README that redirects are not followed', async () => {
    expect(await readmeInstallCount()).toContain('does not follow redirects');
  });

  it('should say in the README that a URL with credentials is refused', async () => {
    expect(await readmeInstallCount()).toContain('A URL with a username or password is refused');
  });

  it.each(['MAILOO_INSTALL_COUNTER', 'MAILOO_INSTALL_COUNTER_URL'])(
    'should name %s in docs/configuration.md',
    async (name) => {
      expect(await document('../../docs/configuration.md')).toContain(`\`${name}\``);
    },
  );

  it.each([...ON_VALUES])('should list the on value %s in docs/configuration.md', async (value) => {
    expect(await document('../../docs/configuration.md')).toContain(`\`${value}\``);
  });

  it('should say in docs/configuration.md that the collector URL is https', async () => {
    expect(await document('../../docs/configuration.md')).toContain('`https` URL');
  });

  it.each(LOOPBACK_FORMS)(
    'should name the loopback form %s in docs/configuration.md',
    async (form) => {
      const configuration = await document('../../docs/configuration.md');
      expect(configuration).toContain('`http` only for');
      expect(configuration).toContain(`\`${form}\``);
    },
  );

  it.each(['MAILOO_INSTALL_COUNTER', 'MAILOO_INSTALL_COUNTER_URL'])(
    'should name %s in SECURITY.md',
    async (name) => {
      expect(await document('../../SECURITY.md')).toContain(`\`${name}\``);
    },
  );

  it('should say in SECURITY.md that the install count is off unless opted in', async () => {
    expect(await securityInstallCount()).toContain('Off unless');
  });

  it.each([...ON_VALUES])('should list the on value %s in SECURITY.md', async (value) => {
    expect(await securityInstallCount()).toContain(`\`${value}\``);
  });

  it.each(NEGATIVE_WORDS)('should list the off word %s in SECURITY.md', async (word) => {
    expect(await securityInstallCount()).toContain(`\`${word}\``);
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

  it('should resolve without a marker when the global fetch rejects', async () => {
    const bound = await processBound(async () => {
      throw new TypeError(`fetch failed ${COLLECTOR}`);
    });
    await expect(bound.noteInstall(VERSION)).resolves.toBeUndefined();
    expect(bound.calls).toHaveLength(1);
    await expect(stat(bound.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should not record the install when the global fetch answers 503', async () => {
    const bound = await processBound(async () => new Response('busy', { status: 503 }));
    await bound.noteInstall(VERSION);
    expect(bound.calls).toHaveLength(1);
    await expect(stat(bound.marker)).rejects.toMatchObject({ code: 'ENOENT' });
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
    await expect(stat(join(dir, 'install-count'))).rejects.toMatchObject({ code: 'ENOENT' });
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

  it('should not follow a redirect to a second server through the real fetch', async () => {
    const second = await loopback(204);
    const first = await loopback(302, second.url);
    const bound = await processBound(undefined, { MAILOO_INSTALL_COUNTER_URL: first.url });
    await bound.noteInstall(VERSION);
    expect(first.hits).toEqual(['POST /install']);
    expect(second.hits).toEqual([]);
    await expect(stat(bound.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
