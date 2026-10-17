import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { WriterLease } from './writer-lease.js';
import { createWriterLease, WRITER_LEASE_RENEW_MS, WRITER_LEASE_STALE_MS } from './writer-lease.js';

// File mtimes come from the real clock, a few ms after the pinned start, so a
// step past the stale window keeps a margin on both sides.
const MARGIN_MS = 1_000;

interface Process {
  lease: WriterLease;
  leads: number;
  losses: number;
  reports: string[];
}

describe('writer lease', () => {
  let root: string;
  let lockPath: string;
  let clock: number;

  function startProcess(): Process {
    const proc: Process = {
      lease: undefined as unknown as WriterLease,
      leads: 0,
      losses: 0,
      reports: [],
    };
    proc.lease = createWriterLease({
      lockPath,
      onLead: () => {
        proc.leads += 1;
      },
      onLose: () => {
        proc.losses += 1;
      },
      report: (message) => {
        proc.reports.push(message);
      },
      now: () => clock,
    });
    return proc;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-lease-'));
    lockPath = path.join(root, 'state', 'mailbox-writers.lock');
    clock = Date.now();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('should let only one of two processes lead', async () => {
    const first = startProcess();
    const second = startProcess();
    await first.lease.tick();
    await second.lease.tick();
    expect([first.leads, second.leads]).toEqual([1, 0]);
  });

  it('should take over a lease its holder stopped renewing', async () => {
    const holder = startProcess();
    const follower = startProcess();
    await holder.lease.tick();
    clock += WRITER_LEASE_STALE_MS + MARGIN_MS;
    await follower.lease.tick();
    expect(follower.lease.leading).toBe(true);
  });

  it('should keep a lease while its holder renews it', async () => {
    const holder = startProcess();
    const follower = startProcess();
    await holder.lease.tick();
    clock += WRITER_LEASE_STALE_MS + MARGIN_MS;
    await holder.lease.tick();
    await follower.lease.tick();
    expect(follower.lease.leading).toBe(false);
  });

  it('should stop its writers when another process took the lease', async () => {
    const holder = startProcess();
    const thief = startProcess();
    await holder.lease.tick();
    clock += WRITER_LEASE_STALE_MS + MARGIN_MS;
    await thief.lease.tick();
    await holder.lease.tick();
    expect({ losses: holder.losses, leading: holder.lease.leading }).toEqual({
      losses: 1,
      leading: false,
    });
  });

  it('should hand the lease to a follower once the holder releases it', async () => {
    const holder = startProcess();
    const follower = startProcess();
    await holder.lease.tick();
    await follower.lease.tick();
    await holder.lease.halt();
    await holder.lease.release();
    await follower.lease.tick();
    expect(follower.lease.leading).toBe(true);
  });

  it('should leave the lease free when a halted process wins it', async () => {
    const halted = startProcess();
    const next = startProcess();
    await halted.lease.halt();
    await halted.lease.tick();
    await next.lease.tick();
    expect([halted.leads, next.leads]).toEqual([0, 1]);
  });

  it('should try again as a follower on every renewal interval', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const holder = startProcess();
    const follower = startProcess();
    await holder.lease.tick();
    await follower.lease.start();
    await holder.lease.release();
    vi.advanceTimersByTime(WRITER_LEASE_RENEW_MS);
    await vi.waitFor(() => {
      expect(follower.lease.leading).toBe(true);
    });
    await follower.lease.halt();
  });

  it('should report a lock it cannot create instead of throwing', async () => {
    await fs.writeFile(path.join(root, 'state'), 'not a directory');
    const proc = startProcess();
    await proc.lease.start();
    await proc.lease.halt();
    expect(proc.reports).toEqual([
      expect.stringMatching(/^Mailbox writer lease: .*(EEXIST|ENOTDIR)/),
    ]);
  });
});
