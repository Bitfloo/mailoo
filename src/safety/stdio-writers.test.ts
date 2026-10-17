import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SHUTDOWN_DEADLINE_MS } from './shutdown.js';
import type { StdioWriterServices } from './stdio-writers.js';
import createStdioWriters from './stdio-writers.js';
import { WRITER_LEASE_RENEW_MS, WRITER_LEASE_STALE_MS } from './writer-lease.js';

function fakeServices(events: string[]): StdioWriterServices {
  return {
    startHooks: () => {
      events.push('start hooks');
    },
    hooks: {
      stop: () => {
        events.push('stop hooks');
      },
    },
    watcher: {
      start: async () => {
        events.push('start watcher');
      },
      stop: async () => {
        events.push('stop watcher');
      },
    },
    startScheduler: () => {
      events.push('start scheduler');
      return () => {
        events.push('stop scheduler');
      };
    },
    connections: {
      closeAll: async () => {
        events.push('close connections');
      },
    },
    server: {
      close: async () => {
        events.push('close server');
      },
    },
  };
}

describe('stdio mailbox writers', () => {
  let root: string;
  let lockPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-stdio-writers-'));
    lockPath = path.join(root, 'mailbox-writers.lock');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  type Log = (level: 'info' | 'warning', message: string) => Promise<void>;

  function start(events: string[], log: Log = async () => undefined) {
    return createStdioWriters({ lockPath, services: fakeServices(events), log });
  }

  function recordLog(): { lines: [string, string][]; log: Log } {
    const lines: [string, string][] = [];
    return {
      lines,
      log: async (level, message) => {
        lines.push([level, message]);
      },
    };
  }

  it('should start hooks, the scheduler and the watcher once it holds the lease', async () => {
    const events: string[] = [];
    const writers = start(events);
    await writers.lease.tick();
    expect(events).toEqual(['start hooks', 'start scheduler', 'start watcher']);
  });

  it('should stop the scheduler, hooks and watcher when another process takes the lease', async () => {
    const events: string[] = [];
    const writers = start(events);
    await writers.lease.tick();
    events.length = 0;
    await fs.writeFile(lockPath, 'token of another process');
    await writers.lease.tick();
    expect(events).toEqual(['stop scheduler', 'stop hooks', 'stop watcher']);
  });

  it('should stop the writers while it holds the lease and free it before closing connections', async () => {
    const events: string[] = [];
    const writers = start(events);
    await writers.lease.tick();
    events.length = 0;
    const holdsLease = async () =>
      fs.access(lockPath).then(
        () => true,
        () => false,
      );
    const observed: [step: string, effects: string[], holdsLease: boolean][] = [];
    for (const [name, step] of writers.shutdownSteps) {
      await step(); // eslint-disable-line no-await-in-loop -- shutdown runs them one after another
      observed.push([name, events.splice(0), await holdsLease()]); // eslint-disable-line no-await-in-loop
    }
    expect(observed).toEqual([
      ['writer lease', [], true],
      ['scheduler', ['stop scheduler'], true],
      ['hooks', ['stop hooks'], true],
      ['watcher', ['stop watcher'], true],
      ['writer lease release', [], false],
      ['connections', ['close connections'], false],
      ['server', ['close server'], false],
    ]);
  });

  it('should not win the lease again once shutdown has halted it', async () => {
    const events: string[] = [];
    await fs.writeFile(lockPath, 'token of the leader');
    const writers = start(events);
    await writers.lease.tick();
    const [, haltLease] = writers.shutdownSteps[0] ?? [];
    await haltLease?.();
    // The leader exits and frees the lease while this process is shutting down.
    await fs.unlink(lockPath);
    await writers.lease.tick();
    expect({ events, leading: writers.lease.leading }).toEqual({ events: [], leading: false });
  });

  it('should log at info that it runs the writers once it holds the lease', async () => {
    const { lines, log } = recordLog();
    const writers = start([], log);
    await writers.lease.tick();
    expect(lines).toEqual([['info', 'This process runs hooks, watcher, and scheduler']]);
  });

  it('should log at warning that another process took over once it lost the lease', async () => {
    const { lines, log } = recordLog();
    const writers = start([], log);
    await writers.lease.tick();
    lines.length = 0;
    await fs.writeFile(lockPath, 'token of another process');
    await writers.lease.tick();
    expect(lines).toEqual([
      ['warning', 'Another Mailoo process took over hooks, watcher, and scheduler'],
    ]);
  });

  it('should log a lease it cannot create at warning', async () => {
    await fs.writeFile(path.join(root, 'state'), 'not a directory');
    lockPath = path.join(root, 'state', 'mailbox-writers.lock');
    const { lines, log } = recordLog();
    const writers = start([], log);
    await writers.lease.tick();
    expect(lines).toEqual([['warning', expect.stringMatching(/^Mailbox writer lease: /)]]);
  });
});

// README points here instead of repeating the numbers, so this one page is checked.
describe('lease and shutdown timings in docs/configuration.md', () => {
  async function timingsUnder(heading: string): Promise<string[]> {
    const doc = await fs.readFile(new URL('../../docs/configuration.md', import.meta.url), 'utf8');
    const start = doc.indexOf(`\n## ${heading}\n`);
    if (start === -1) throw new Error(`docs/configuration.md has no "## ${heading}" section`);
    const end = doc.indexOf('\n## ', start + 1);
    const text = doc.slice(start, end).replace(/\s+/g, ' ');
    return [...text.matchAll(/\d+ (?:seconds|minutes)/g)].map(([phrase]) => phrase);
  }

  it('should state the renewal, retry, takeover and stale window the writer lease uses', async () => {
    const renew = `${WRITER_LEASE_RENEW_MS / 1000} seconds`;
    expect(await timingsUnder('One mailbox writer per machine')).toEqual([
      renew,
      renew,
      renew,
      `${WRITER_LEASE_STALE_MS / 60_000} minutes`,
    ]);
  });

  it('should state the shutdown deadline the code uses', async () => {
    expect(await timingsUnder('Shutdown')).toEqual([`${SHUTDOWN_DEADLINE_MS / 1000} seconds`]);
  });
});
