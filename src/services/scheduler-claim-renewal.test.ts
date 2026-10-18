import type { FileHandle } from 'node:fs/promises';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import queueId from '../test-support/queue-id.js';
import {
  CLAIM_RENEW_MS,
  createService,
  SCHEDULE_CLAIM_SUFFIX,
  STALE_LOCK_MS,
  writeDue,
} from '../test-support/scheduler-fixtures.js';
import withTrackedUtimes from '../test-support/tracked-utimes.js';

describe('overlapping queue checks', () => {
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
        await vi.advanceTimersByTimeAsync(CLAIM_RENEW_MS * 2);
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
