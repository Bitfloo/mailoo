/** The count belongs to the stdio and http server starts and to nothing else. */

import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';

import {
  COLLECTOR_WAIT_MS,
  markerPath,
  SERVER_START_MS,
  SPAWN_TEST_MS,
  startCollector,
  startMailoo,
  withinMs,
} from './test-support/install-count-child.js';

const ENTRY_CONFIG = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

// A TOML table header that never closes: the loader throws before any server exists.
const INVALID_CONFIG = '[[accounts]\nname = "test"\n';

const CONFIG_TEXT = { valid: ENTRY_CONFIG, invalid: INVALID_CONFIG, missing: undefined } as const;

// The marker is written right after the collector's 2xx; this bounds a hang only.
const MARKER_WAIT_MS = 5_000;

/** Holds a loopback port until the test ends, so a server asked to bind it fails. */
async function occupyLoopbackPort(): Promise<number> {
  const blocker = http.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve) => {
      blocker.close(() => resolve());
    });
  });
  const address = blocker.address();
  return typeof address === 'object' && address ? address.port : 0;
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function packageVersion(): Promise<string> {
  const manifest = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

/**
 * Verbs the entry switch names, except the two servers. Read from the source
 * so a verb added to main() without an entry below fails the roster test.
 */
async function entryVerbs(): Promise<string[]> {
  const source = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('async function main()');
  const body = source.slice(start, source.indexOf('main().catch', start));
  const labels = [...body.matchAll(/case '([^']+)':/g)].map((match) => match[1] ?? '');
  return labels.filter((label) => label !== 'stdio' && label !== 'http');
}

/**
 * Arguments after each verb that end without a prompt, a socket or a write
 * outside the tmp HOME. setup takes none: it runs `account add`, which refuses
 * a stdin that is not a TTY before it reads or writes anything; its success path
 * needs the interactive wizard and is not covered here. `test` names an account
 * that is not configured, so it stops before any IMAP or SMTP probe; its success
 * path runs against GreenMail in the integration lane.
 */
const HARMLESS_ARGS: Record<string, string[]> = {
  setup: [],
  account: ['help'],
  test: ['no-such-account'],
  config: ['path'],
  install: ['help'],
  scheduler: ['help'],
  notify: ['help'],
  '--version': [],
  '-v': [],
  help: [],
  '--help': [],
  '-h': [],
};

describe('install count at the server entry', () => {
  it.each([
    ['stdio', async () => ['stdio']],
    ['http', async () => ['http', String(await freeLoopbackPort()), '127.0.0.1']],
  ] as const)(
    'should post the install fields when the %s server starts',
    async (_transport, argv) => {
      const collector = await startCollector();
      const started = await startMailoo(await argv(), collector.url, ENTRY_CONFIG);
      const request = await withinMs(
        Promise.race([
          collector.first,
          started.exited.then(() => {
            throw new Error(`server exited before the count: ${started.output()}`);
          }),
        ]),
        COLLECTOR_WAIT_MS,
        'the install count',
      );
      expect(request.method).toBe('POST');
      expect(request.path).toBe('/install');
      expect(request.contentType).toBe('application/json');
      expect(JSON.parse(request.body)).toEqual({
        product: 'mailoo',
        version: await packageVersion(),
        event: 'install',
        node_major: Number(process.versions.node.split('.')[0]),
      });
    },
    SPAWN_TEST_MS,
  );

  it.each([
    ['stdio', 'missing'],
    ['stdio', 'invalid'],
    ['http', 'missing'],
    ['http', 'invalid'],
  ] as const)(
    'should not count a %s start that fails on a %s config',
    async (transport, configFile) => {
      const collector = await startCollector();
      const args =
        transport === 'stdio' ? ['stdio'] : ['http', String(await freeLoopbackPort()), '127.0.0.1'];
      const started = await startMailoo(args, collector.url, CONFIG_TEXT[configFile]);
      const code = await withinMs(started.exited, SERVER_START_MS, 'the failed start to exit');
      expect(code).not.toBe(0);
      expect(collector.received).toHaveLength(0);
      await expect(stat(markerPath(started))).rejects.toMatchObject({ code: 'ENOENT' });
    },
    SPAWN_TEST_MS,
  );

  it.each([
    ['stdio', async () => ['stdio']],
    ['http', async () => ['http', String(await freeLoopbackPort()), '127.0.0.1']],
  ] as const)(
    'should send exactly one request and record the marker when the %s server starts',
    async (_transport, argv) => {
      const collector = await startCollector();
      const started = await startMailoo(await argv(), collector.url, ENTRY_CONFIG);
      await withinMs(collector.first, COLLECTOR_WAIT_MS, 'the install count');
      await vi.waitFor(async () => stat(markerPath(started)), {
        timeout: MARKER_WAIT_MS,
        interval: 50,
      });
      expect(collector.received).toHaveLength(1);
    },
    SPAWN_TEST_MS,
  );

  it(
    'should not count an http start whose port is already taken',
    async () => {
      const collector = await startCollector();
      const port = await occupyLoopbackPort();
      const started = await startMailoo(
        ['http', String(port), '127.0.0.1'],
        collector.url,
        ENTRY_CONFIG,
      );
      const code = await withinMs(started.exited, SERVER_START_MS, 'the failed start to exit');
      expect(code).not.toBe(0);
      expect(collector.received).toHaveLength(0);
      await expect(stat(markerPath(started))).rejects.toMatchObject({ code: 'ENOENT' });
    },
    SPAWN_TEST_MS,
  );

  it(
    'should not count an unknown command',
    async () => {
      const collector = await startCollector();
      const started = await startMailoo(['definitely-not-a-verb'], collector.url, ENTRY_CONFIG);
      const code = await withinMs(started.exited, SERVER_START_MS, 'the command exit');
      expect(code).not.toBe(0);
      expect(collector.received).toHaveLength(0);
      await expect(stat(markerPath(started))).rejects.toMatchObject({ code: 'ENOENT' });
    },
    SPAWN_TEST_MS,
  );

  it('should name a harmless argument for every non-server verb in the entry switch', async () => {
    const verbs = await entryVerbs();
    expect(verbs.sort()).toEqual(Object.keys(HARMLESS_ARGS).sort());
  });

  it.each(Object.keys(HARMLESS_ARGS))(
    'should not count the `%s` command',
    async (verb) => {
      const collector = await startCollector();
      const started = await startMailoo(
        [verb, ...(HARMLESS_ARGS[verb] ?? [])],
        collector.url,
        ENTRY_CONFIG,
      );
      await withinMs(started.exited, SERVER_START_MS, 'the command exit');
      expect(collector.received).toHaveLength(0);
      await expect(stat(markerPath(started))).rejects.toMatchObject({ code: 'ENOENT' });
    },
    SPAWN_TEST_MS,
  );
});
