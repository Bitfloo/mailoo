import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StdioWriterServices } from './stdio-writers.js';
import createStdioWriters from './stdio-writers.js';

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

  function start(events: string[]) {
    return createStdioWriters({
      lockPath,
      services: fakeServices(events),
      log: async () => undefined,
    });
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
});
