import type { FileHandle } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import queueId from '../test-support/queue-id.js';
import {
  createService,
  pendingRecord,
  SCHEDULE_CLAIM_SUFFIX,
  STALE_LOCK_MS,
} from '../test-support/scheduler-fixtures.js';
import withTrackedUtimes from '../test-support/tracked-utimes.js';
import type { ScheduledEmail } from '../types/index.js';

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
  async function writeDue(queueDir: string, id: string, status: ScheduledEmail['status']) {
    const record = {
      ...pendingRecord(id, '2020-01-01T00:00:00.000Z'),
      status,
    };
    await fs.writeFile(path.join(queueDir, `${id}.json`), JSON.stringify(record));
  }

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

  async function mtimeOf(lockPath: string): Promise<number> {
    const stat = await fs.stat(lockPath);
    return stat.mtimeMs;
  }

  it('sends a due email once when a second check runs while SMTP is still sending', async () => {
    // The claim mtime is the filesystem clock. Fake timers start at that same
    // time and are not pinned with setSystemTime, so a renewal is a newer mtime.
    vi.useFakeTimers();
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-renew-'));
    const id = queueId(2);
    const lockPath = path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
    const first = createService(queueDir);
    let releaseSend: (value: { messageId: string }) => void = () => {};
    const pending = new Promise<{ messageId: string }>((resolve) => {
      releaseSend = resolve;
    });
    let markSending: () => void = () => {};
    const sendStarted = new Promise<void>((resolve) => {
      markSending = resolve;
    });
    first.smtp.sendEmail.mockImplementation(async () => {
      markSending();
      return pending;
    });
    let sending: Promise<unknown> = Promise.resolve();
    try {
      await writeDue(queueDir, id, 'pending');
      // No vi.waitFor here: under fake timers each poll moves the clock, so a
      // renewal due only at the stale window would land inside the wait.
      let renewed = false;
      await withTrackedUtimes(async (settled) => {
        sending = first.service.checkAndSend();
        await sendStarted;
        const before = await mtimeOf(lockPath);
        // Short of one stale window, so a renewal slower than the window would not land.
        await vi.advanceTimersByTimeAsync(STALE_LOCK_MS - 1);
        await settled();
        renewed = (await mtimeOf(lockPath)) > before;
      });
      const second = createService(queueDir);
      await second.service.checkAndSend();
      releaseSend({ messageId: '<scheduled@example.com>' });
      await sending;
      const calls =
        first.smtp.sendEmail.mock.calls.length + second.smtp.sendEmail.mock.calls.length;
      const sent = await first.service.list({ status: 'sent' });
      expect({ renewed, calls, sent: sent.length }).toEqual({ renewed: true, calls: 1, sent: 1 });
    } finally {
      releaseSend({ messageId: '<scheduled@example.com>' });
      await sending.catch(() => undefined);
      vi.useRealTimers();
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  // The sent record is the commit point. A claim that went stale while it is
  // written would let a second check send the email again.
  it('should keep renewing the claim while the sent record is written', async () => {
    vi.useFakeTimers();
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-renew-record-'));
    const id = queueId(9);
    const lockPath = path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
    const probe = await fs.open(os.devNull, 'r');
    const proto = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const handleWrite = proto.writeFile;
    let markWriting: () => void = () => {};
    const writing = new Promise<void>((resolve) => {
      markWriting = resolve;
    });
    let releaseWrite: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const spy = vi.spyOn(proto, 'writeFile').mockImplementation(async function heldWrite(
      this: FileHandle,
      data,
      options,
    ) {
      if (typeof data === 'string' && data.includes('"status": "sent"')) {
        markWriting();
        await released;
      }
      return handleWrite.call(this, data, options);
    });
    let checking: Promise<unknown> = Promise.resolve();
    try {
      await writeDue(queueDir, id, 'pending');
      const { service } = createService(queueDir);
      let renewed = false;
      await withTrackedUtimes(async (settled) => {
        checking = service.checkAndSend();
        await writing;
        const before = await mtimeOf(lockPath);
        await vi.advanceTimersByTimeAsync(STALE_LOCK_MS - 1);
        await settled();
        renewed = (await mtimeOf(lockPath)) > before;
      });
      releaseWrite();
      await checking;
      expect(renewed).toBe(true);
    } finally {
      releaseWrite();
      await checking.catch(() => undefined);
      spy.mockRestore();
      vi.useRealTimers();
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  // A renewal left running would keep a later holder's claim fresh after that
  // holder died, so the email would stay held back for as long as this process lives.
  it('should stop renewing the claim once the send finished', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-renew-stop-'));
    const id = queueId(8);
    const lockPath = path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
    try {
      await writeDue(queueDir, id, 'pending');
      const { service } = createService(queueDir);
      await withTrackedUtimes(async (settled) => {
        await service.checkAndSend();
        await fs.writeFile(lockPath, 'another check', { flag: 'wx' });
        const takenAt = new Date(Date.now() - 1_000);
        await fs.utimes(lockPath, takenAt, takenAt);
        const before = await mtimeOf(lockPath);
        // Two 60 s renewal intervals.
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        await settled();
        expect(await mtimeOf(lockPath)).toBe(before);
      });
    } finally {
      vi.useRealTimers();
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('does not remove the new holder lock when the previous holder finishes', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-release-'));
    const id = queueId(3);
    const lockPath = path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
    const stolen = 'stolen-holder';
    const { service, smtp } = createService(queueDir);
    let releaseSend: (value: { messageId: string }) => void = () => {};
    const pending = new Promise<{ messageId: string }>((resolve) => {
      releaseSend = resolve;
    });
    smtp.sendEmail.mockReturnValue(pending);
    let sending: Promise<unknown> = Promise.resolve();
    try {
      await writeDue(queueDir, id, 'pending');
      sending = service.checkAndSend();
      await vi.waitFor(() => {
        expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
      });
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, stolen, { flag: 'wx' });
      releaseSend({ messageId: '<scheduled@example.com>' });
      await sending;
      expect(await fs.readFile(lockPath, 'utf8')).toBe(stolen);
    } finally {
      releaseSend({ messageId: '<scheduled@example.com>' });
      await sending.catch(() => undefined);
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('leaves a newer claim in place when a stale claim is restored', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-restore-'));
    const id = queueId(4);
    const lockPath = path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
    const newer = 'newer-holder';
    const originalRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (String(from) === lockPath) {
        const fresh = new Date();
        await fs.utimes(to, fresh, fresh);
        await fs.writeFile(lockPath, newer, { flag: 'wx' });
      }
    });
    try {
      await writeDue(queueDir, id, 'sending');
      await fs.writeFile(lockPath, 'abandoned', { flag: 'wx' });
      const abandonedAt = new Date(Date.now() - STALE_LOCK_MS - 1000);
      await fs.utimes(lockPath, abandonedAt, abandonedAt);
      const { service } = createService(queueDir);
      const result = await service.checkAndSend();
      expect(await fs.readFile(lockPath, 'utf8')).toBe(newer);
      expect(result.errors).toEqual([]);
    } finally {
      spy.mockRestore();
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  // No newer claim here, so only the age check after parking stops the take-over.
  it('should put back and not send past a parked claim its holder renewed meanwhile', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-renewed-'));
    const id = queueId(4);
    const lockPath = path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
    const originalRename = fs.rename.bind(fs);
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (String(from) === lockPath) {
        const renewed = new Date();
        await fs.utimes(to, renewed, renewed);
      }
    });
    try {
      await writeDue(queueDir, id, 'sending');
      await fs.writeFile(lockPath, 'renewing', { flag: 'wx' });
      const lateRenewal = new Date(Date.now() - STALE_LOCK_MS - 1000);
      await fs.utimes(lockPath, lateRenewal, lateRenewal);
      const { service, smtp } = createService(queueDir);
      await service.checkAndSend();
      expect({
        lock: await fs.readFile(lockPath, 'utf8').catch(() => 'gone'),
        sends: smtp.sendEmail.mock.calls.length,
      }).toEqual({ lock: 'renewing', sends: 0 });
    } finally {
      spy.mockRestore();
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});
