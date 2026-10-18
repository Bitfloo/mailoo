/**
 * The stdio server's mailbox writers behind the writer lease, and the order
 * shutdown stops them in. main.ts is not unit-tested, so the wiring lives here.
 */

import type { ShutdownStep } from './shutdown.js';
import type { MailboxWriterStarts } from './write-side-effects.js';
import { startMailboxWriters } from './write-side-effects.js';
import type { WriterLease } from './writer-lease.js';
import { createWriterLease } from './writer-lease.js';

export interface StdioWriterServices {
  startHooks: () => void;
  hooks: { stop: () => void };
  watcher: { start: () => Promise<void>; stop: () => Promise<void> };
  /** Starts the scheduler loop and returns the function that stops it. */
  startScheduler: () => () => void;
  connections: { closeAll: () => Promise<void> };
  server: { close: () => Promise<void> };
}

export interface StdioWriters {
  readonly lease: WriterLease;
  readonly shutdownSteps: ShutdownStep[];
}

export default function createStdioWriters(options: {
  lockPath: string;
  services: StdioWriterServices;
  log: (level: 'info' | 'warning', message: string) => Promise<void>;
}): StdioWriters {
  const { services, log } = options;
  let stopScheduler: (() => void) | undefined;
  const starts: MailboxWriterStarts = {
    startHooks: services.startHooks,
    startWatcher: async () => services.watcher.start(),
    startScheduler: () => {
      stopScheduler = services.startScheduler();
    },
  };
  const stops: ShutdownStep[] = [
    ['scheduler', () => stopScheduler?.()],
    ['hooks', () => services.hooks.stop()],
    ['watcher', async () => services.watcher.stop()],
  ];

  const lease = createWriterLease({
    lockPath: options.lockPath,
    onLead: async () => {
      await startMailboxWriters(starts);
      await log('info', 'This process runs hooks, watcher, and scheduler');
    },
    onLose: async () => {
      // eslint-disable-next-line no-restricted-syntax
      for (const [, stop] of stops) {
        await stop(); // eslint-disable-line no-await-in-loop -- one at a time, in shutdown order
      }
      await log('warning', 'Another Mailoo process took over hooks, watcher, and scheduler');
    },
    report: (message) => {
      log('warning', message).catch(() => undefined);
    },
  });

  return {
    lease,
    shutdownSteps: [
      // Halt first so this process cannot win the lease mid-shutdown, and
      // release only after its writers stopped so the next leader never overlaps them.
      ['writer lease', async () => lease.halt()],
      ...stops,
      ['writer lease release', async () => lease.release()],
      ['connections', async () => services.connections.closeAll()],
      ['server', async () => services.server.close()],
    ],
  };
}
