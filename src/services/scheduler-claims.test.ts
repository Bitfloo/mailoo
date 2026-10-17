import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import queueId from '../test-support/queue-id.js';
import {
  createService,
  SCHEDULE_CLAIM_SUFFIX,
  STALE_LOCK_MS,
  writeDue,
} from '../test-support/scheduler-fixtures.js';

function isCancelled(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'cancelled' in value &&
    (value as { cancelled: boolean }).cancelled
  );
}

/**
 * Both checks must observe the pending bytes before either continues.
 * Otherwise one check can finish before the other starts, and a missing claim stays green.
 */
async function afterBothReadQueueFile(filePath: string, body: () => Promise<void>): Promise<void> {
  let seen = 0;
  let release: () => void = () => {};
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = fs.readFile.bind(fs);
  const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
    const content = await original(file, options as { encoding: 'utf8' });
    if (file === filePath && seen < 2) {
      seen += 1;
      if (seen === 2) release();
      else await both;
    }
    return content;
  });
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
}

describe('overlapping queue checks', () => {
  it('sends a due email once when two checks run together', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-race-'));
    const id = queueId(1);
    const filePath = path.join(queueDir, `${id}.json`);
    try {
      await writeDue(queueDir, id, 'pending');
      const first = createService(queueDir);
      const second = createService(queueDir);
      let left = { sent: 0, failed: 0, errors: [] as string[] };
      let right = { sent: 0, failed: 0, errors: [] as string[] };
      await afterBothReadQueueFile(filePath, async () => {
        [left, right] = await Promise.all([
          first.service.checkAndSend(),
          second.service.checkAndSend(),
        ]);
      });
      const calls =
        first.smtp.sendEmail.mock.calls.length + second.smtp.sendEmail.mock.calls.length;
      const sent = await first.service.list({ status: 'sent' });
      expect(left.sent + right.sent).toBe(1);
      expect(calls).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ id, status: 'sent' });
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  /** Cancel overlaps the moment the checker records "sending", while the queue file still says pending. */
  async function raceCancelWithSendingWrite() {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-cancel-'));
    const id = queueId(1);
    const filePath = path.join(queueDir, `${id}.json`);
    const checker = createService(queueDir);
    const canceller = createService(queueDir);
    await writeDue(queueDir, id, 'pending');
    const original = fs.rename.bind(fs);
    let started = false;
    let cancelResult: unknown;
    // The record is replaced by renaming a temp file over it, so the hook sits on that rename.
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (
        String(to) === filePath &&
        !started &&
        (await fs.readFile(from, 'utf8')).includes('"status": "sending"')
      ) {
        started = true;
        cancelResult = await canceller.service.cancel(id).then(
          (result) => result,
          (err: unknown) => err,
        );
      }
      return original(from, to);
    });
    try {
      const outcome = await checker.service.checkAndSend();
      const sentRecords = (await checker.service.list({ status: 'sent' })).length;
      return {
        started,
        cancelled: isCancelled(cancelResult),
        reportedSent: outcome.sent,
        sentRecords,
        sends: checker.smtp.sendEmail.mock.calls.length,
      };
    } finally {
      spy.mockRestore();
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  }

  it('should not report a cancelled email as sent', async () => {
    const race = await raceCancelWithSendingWrite();
    const sentAnyway = race.reportedSent > 0 || race.sentRecords > 0 || race.sends > 0;
    expect({ started: race.started, cancelledButSent: race.cancelled && sentAnyway }).toEqual({
      started: true,
      cancelledButSent: false,
    });
  });

  it('should either cancel or send once when cancel races the sending write', async () => {
    const { started, cancelled, sends, sentRecords } = await raceCancelWithSendingWrite();
    expect({ started, cancelled, sends, sentRecords }).toEqual(
      cancelled
        ? { started: true, cancelled: true, sends: 0, sentRecords: 0 }
        : { started: true, cancelled: false, sends: 1, sentRecords: 1 },
    );
  });

  it('retries a claim older than the stale lock window and sends it once', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-stale-'));
    const id = queueId(1);
    try {
      await writeDue(queueDir, id, 'sending');
      const lockPath = path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
      await fs.writeFile(lockPath, 'abandoned', { flag: 'wx' });
      const abandonedAt = new Date(Date.now() - STALE_LOCK_MS - 1000);
      await fs.utimes(lockPath, abandonedAt, abandonedAt);
      const { service, smtp } = createService(queueDir);
      const result = await service.checkAndSend();
      const sent = await service.list({ status: 'sent' });
      expect(result.sent).toBe(1);
      expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ id, status: 'sent' });
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('does not take a claim whose age is exactly the stale window', async () => {
    // A whole-second clock keeps the claim mtime exact, so its age is STALE_LOCK_MS to the ms.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-boundary-'));
    const id = queueId(5);
    const lockPath = path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
    try {
      await writeDue(queueDir, id, 'pending');
      await fs.writeFile(lockPath, 'held', { flag: 'wx' });
      const claimedAt = new Date(Date.now() - STALE_LOCK_MS);
      await fs.utimes(lockPath, claimedAt, claimedAt);
      const { service } = createService(queueDir);
      await service.checkAndSend();
      expect(await service.list({ status: 'sent' })).toEqual([]);
    } finally {
      vi.useRealTimers();
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  /** Emails sent by one check while another holder's claim is ageMs old. */
  async function sentPastClaimAged(ageMs: number): Promise<number> {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-window-'));
    const id = queueId(6);
    const lockPath = path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
    try {
      await writeDue(queueDir, id, 'sending');
      await fs.writeFile(lockPath, 'held', { flag: 'wx' });
      const claimedAt = new Date(Date.now() - ageMs);
      await fs.utimes(lockPath, claimedAt, claimedAt);
      const { service } = createService(queueDir);
      return (await service.checkAndSend()).sent;
    } finally {
      vi.useRealTimers();
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  }

  // Literals, not STALE_LOCK_MS: a dead holder may hold an email back for five minutes, no longer.
  // Half a second inside the window, so a window shortened to 299 s would take it.
  it('should leave a claim 299 500 ms old with its holder', async () => {
    expect(await sentPastClaimAged(299_500)).toBe(0);
  });

  // Half a second outside the window, so a window lengthened past it would keep the claim.
  it('should take a claim 300 500 ms old and send the email', async () => {
    expect(await sentPastClaimAged(300_500)).toBe(1);
  });
});
