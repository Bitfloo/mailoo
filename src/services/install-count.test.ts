/**
 * The runner's CI and VITEST variables are not the operator's env. Each test
 * passes the env object the decision reads, and a fetch that records calls.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  InstallCountFetch,
  InstallCountRequest,
  InstallCountResult,
} from './install-count.js';
import { recordInstall } from './install-count.js';

const VERSION = '9.9.9';
const NODE_MAJOR = 24;
const COLLECTOR = 'https://collector.example/install';

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
    const marker = await readFile(join(dir, 'install-count'), 'utf8');
    expect(marker).toBe('1\n');
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

  it('should count only from the stdio and http server starts', async () => {
    const main = await readFile(new URL('../main.ts', import.meta.url), 'utf8');
    expect(main.split('noteInstall(').length - 1).toBe(2);
  });
});
