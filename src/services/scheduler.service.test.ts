import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ScheduledEmail } from '../types/index.js';

const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-'));
vi.stubEnv('XDG_STATE_HOME', stateHome);

const {
  default: SchedulerService,
  SCHEDULE_CLAIM_SUFFIX,
  STALE_LOCK_MS,
} = await import('./scheduler.service.js');

const scheduledDir = path.join(stateHome, 'mailoo', 'scheduled');

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Two days ahead, minute precision. A numeric offset is still in the future. */
function futureMinute(offset: 'Z' | '+02:00'): string {
  const when = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const year = when.getUTCFullYear();
  const month = String(when.getUTCMonth() + 1).padStart(2, '0');
  const day = String(when.getUTCDate()).padStart(2, '0');
  const hour = String(when.getUTCHours()).padStart(2, '0');
  const minute = String(when.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}${offset}`;
}

function createService(queueDir?: string) {
  const imap = {
    saveDraft: vi.fn().mockRejectedValue(new Error('draft unavailable')),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
  };
  const smtp = {
    sendEmail: vi.fn().mockResolvedValue({ messageId: '<scheduled@example.com>' }),
  };
  const service = new SchedulerService(smtp as never, imap as never, queueDir);
  return { service, imap, smtp };
}

function queueId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function jsonNames(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

function pendingRecord(id: string, sendAt: string): ScheduledEmail {
  return {
    id,
    account: 'personal',
    to: ['user@example.com'],
    subject: 'Hello',
    body: 'Body',
    html: false,
    sendAt,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    attempts: 0,
  };
}

async function fillQueue(
  queueDir: string,
  count: number,
  status: ScheduledEmail['status'],
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, async (_unused, index) => {
      const id = queueId(index);
      await fs.writeFile(
        path.join(queueDir, `${id}.json`),
        JSON.stringify({ ...pendingRecord(id, daysFromNow(2)), status }),
      );
    }),
  );
}

async function liveFileCount(dir: string): Promise<number> {
  const names = await jsonNames(dir);
  const statuses = await Promise.all(
    names.map(async (name) => {
      const content = await fs.readFile(path.join(dir, name), 'utf8');
      const scheduled = JSON.parse(content) as ScheduledEmail;
      return scheduled.status;
    }),
  );
  return statuses.filter((status) => status === 'pending' || status === 'sending').length;
}

async function scheduleHello(service: InstanceType<typeof SchedulerService>) {
  return service.schedule('personal', {
    to: ['user@example.com'],
    subject: 'Hello',
    body: 'Body',
    sendAt: daysFromNow(2),
  });
}

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(stateHome, { recursive: true, force: true });
});

describe('SchedulerService queue files', () => {
  it('does not delete a file outside the queue when the schedule id leaves the directory', async () => {
    const canaryDir = path.join(stateHome, 'mailoo', 'canary');
    await fs.mkdir(canaryDir, { recursive: true });
    const canary = path.join(canaryDir, 'secret.json');
    await fs.writeFile(canary, `${JSON.stringify(pendingRecord('x', daysFromNow(1)))}\n`);
    const { service } = createService();

    await expect(service.cancel('../canary/secret')).rejects.toThrow(/id/);
    expect(await fs.readFile(canary, 'utf8')).toContain('"status":"pending"');
  });

  it('does not write outside the queue when a stored id leaves the directory', async () => {
    const outside = path.join(stateHome, 'mailoo', 'escaped.json');
    await fs.mkdir(scheduledDir, { recursive: true });
    const filename = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json';
    await fs.writeFile(
      path.join(scheduledDir, filename),
      JSON.stringify(pendingRecord('../escaped', daysFromNow(-1))),
    );
    const { service } = createService();

    await service.checkAndSend();
    await expect(fs.access(outside)).rejects.toThrow();
  });

  it('accepts a send_at value with minute precision and a Z offset', async () => {
    const { service } = createService();
    const sendAt = futureMinute('Z');
    const scheduled = await service.schedule('personal', {
      to: ['user@example.com'],
      subject: 'Hello',
      body: 'Body',
      sendAt,
    });
    expect(scheduled.sendAt).toBe(new Date(sendAt).toISOString());
  });

  it('accepts a send_at value with minute precision and a numeric UTC offset', async () => {
    const { service } = createService();
    const sendAt = futureMinute('+02:00');
    const scheduled = await service.schedule('personal', {
      to: ['user@example.com'],
      subject: 'Hello',
      body: 'Body',
      sendAt,
    });
    expect(scheduled.sendAt).toBe(new Date(sendAt).toISOString());
  });

  it('rejects a send_at value that has no UTC offset', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: '2026-10-01T09:00:00',
      }),
    ).rejects.toThrow('ISO 8601 date-time with UTC offset, e.g. 2026-10-01T09:00:00+02:00');
  });

  it('rejects a send_at value that is not an ISO-8601 timestamp', async () => {
    const { service } = createService();
    const before = await jsonNames(scheduledDir);
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: '01/01/2099',
      }),
    ).rejects.toThrow(/send_at/);
    expect(await jsonNames(scheduledDir)).toEqual(before);
  });

  it('rejects a send_at value more than 366 days ahead', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(400),
      }),
    ).rejects.toThrow(/366/);
  });

  it('rejects more recipients than the schedule limit', async () => {
    const { service } = createService();
    const to = Array.from({ length: 51 }, (_unused, index) => `user${index}@example.com`);
    await expect(
      service.schedule('personal', {
        to,
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
      }),
    ).rejects.toThrow(/recipient/i);
  });

  it('rejects a subject that contains a line break', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello\r\nBcc: other@example.com',
        body: 'Body',
        sendAt: daysFromNow(2),
      }),
    ).rejects.toThrow(/[Ss]ubject/);
  });

  it('rejects a subject longer than 998 characters', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 's'.repeat(999),
        body: 'Body',
        sendAt: daysFromNow(2),
      }),
    ).rejects.toThrow(/[Ss]ubject/);
  });

  it('rejects an In-Reply-To value that contains a line break', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
        inReplyTo: 'x\r\nBcc: y@example.com',
      }),
    ).rejects.toThrow(/In-Reply-To/);
  });

  it('rejects a References item that contains a newline', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
        references: ['<id@example.com>\n'],
      }),
    ).rejects.toThrow(/References/);
  });

  it('accepts an account name of exactly 128 characters', async () => {
    const { service } = createService();
    const account = 'a'.repeat(128);
    const scheduled = await service.schedule(account, {
      to: ['user@example.com'],
      subject: 'Hello',
      body: 'Body',
      sendAt: daysFromNow(2),
    });
    expect(scheduled.account).toBe(account);
  });

  it('rejects an account name one character over 128', async () => {
    const { service } = createService();
    await expect(
      service.schedule('a'.repeat(129), {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
      }),
    ).rejects.toThrow(/Account name/);
  });

  it('rejects an address that is not an email', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['not-an-email'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
      }),
    ).rejects.toThrow(/recipient/i);
  });

  it('stores a valid schedule inside the queue directory', async () => {
    const { service } = createService();
    const scheduled = await service.schedule('personal', {
      to: ['user@example.com'],
      subject: 'Hello',
      body: 'Body',
      sendAt: daysFromNow(2),
    });
    const filePath = path.join(scheduledDir, `${scheduled.id}.json`);
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8')) as ScheduledEmail;
    expect(saved.id).toBe(scheduled.id);
    expect(saved.to).toEqual(['user@example.com']);
    expect(path.relative(scheduledDir, filePath).startsWith('..')).toBe(false);
  });

  it('rejects a schedule when the queue already holds 100 messages', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-pending-'));
    try {
      await fillQueue(queueDir, 100, 'pending');
      const { service } = createService(queueDir);
      await expect(
        service.schedule('personal', {
          to: ['user@example.com'],
          subject: 'Hello',
          body: 'Body',
          sendAt: daysFromNow(2),
        }),
      ).rejects.toThrow(/100/);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('schedules an email when the queue holds 100 failed messages and no pending ones', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-failed-'));
    try {
      await fillQueue(queueDir, 100, 'failed');
      const { service } = createService(queueDir);
      const scheduled = await service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
      });
      expect(scheduled.status).toBe('pending');
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('rejects a schedule when 100 messages are still being sent', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-sending-'));
    try {
      await fillQueue(queueDir, 100, 'sending');
      const { service } = createService(queueDir);
      await expect(
        service.schedule('personal', {
          to: ['user@example.com'],
          subject: 'Hello',
          body: 'Body',
          sendAt: daysFromNow(2),
        }),
      ).rejects.toThrow(/Too many scheduled emails/);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('admits one schedule when ten calls race at 99 live files', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-pending-'));
    try {
      await fillQueue(queueDir, 99, 'pending');
      const { service } = createService(queueDir);
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, async () => scheduleHello(service)),
      );
      const messages = results.flatMap((result) => {
        if (result.status !== 'rejected') return [];
        const { reason } = result;
        return [reason instanceof Error ? reason.message : String(reason)];
      });
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(messages).toEqual(
        Array.from({ length: 9 }, () => expect.stringMatching(/Too many scheduled emails/)),
      );
      expect(await liveFileCount(queueDir)).toBe(100);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('schedules an email after a raced batch once one schedule is cancelled', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-pending-'));
    try {
      await fillQueue(queueDir, 99, 'pending');
      const { service } = createService(queueDir);
      await Promise.allSettled(Array.from({ length: 10 }, async () => scheduleHello(service)));
      await service.cancel(queueId(0));
      const scheduled = await scheduleHello(service);
      expect(scheduled.status).toBe('pending');
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});

describe('send_at calendar dates', () => {
  beforeEach(() => {
    // Faking timers as well hangs the async queue writes.
    // 2028-02-29 is inside the horizon; a rolled-over impossible date is in the past.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-01-15T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function scheduleAt(sendAt: string) {
    const { service } = createService();
    return service.schedule('personal', {
      to: ['user@example.com'],
      subject: 'Hello',
      body: 'Body',
      sendAt,
    });
  }

  it('rejects a send_at of 30 February', async () => {
    await expect(scheduleAt('2027-02-30T09:00Z')).rejects.toThrow(
      'Expected ISO 8601 date-time with UTC offset',
    );
  });

  it('rejects a send_at of 31 September', async () => {
    await expect(scheduleAt('2026-09-31T09:00Z')).rejects.toThrow(
      'Expected ISO 8601 date-time with UTC offset',
    );
  });

  it('rejects a send_at hour of 24', async () => {
    await expect(scheduleAt('2026-10-01T24:00Z')).rejects.toThrow(
      'Expected ISO 8601 date-time with UTC offset',
    );
  });

  it('rejects 29 February when the year is not a leap year', async () => {
    await expect(scheduleAt('2027-02-29T09:00Z')).rejects.toThrow(
      'Expected ISO 8601 date-time with UTC offset',
    );
  });

  it('accepts 29 February when the year is a leap year inside the horizon', async () => {
    const scheduled = await scheduleAt('2028-02-29T09:00Z');
    expect(scheduled.sendAt).toBe('2028-02-29T09:00:00.000Z');
  });
});

describe('send_at century years', () => {
  beforeEach(() => {
    // Faking timers as well hangs the async queue writes.
    // 2100-03-01 is inside the horizon from 2099-06-01, and Date rolls 29 February onto it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2099-06-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects 29 February when the century year is not divisible by 400', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: '2100-02-29T09:00:00Z',
      }),
    ).rejects.toThrow('Expected ISO 8601 date-time with UTC offset');
  });
});

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

  it('does not cancel and send the same due email', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-cancel-'));
    const id = queueId(1);
    const filePath = path.join(queueDir, `${id}.json`);
    const checker = createService(queueDir);
    const canceller = createService(queueDir);
    await writeDue(queueDir, id, 'pending');
    const original = fs.writeFile.bind(fs);
    let started = false;
    let cancelResult: unknown;
    // Cancel overlaps the moment the checker records "sending", while the queue file still says pending.
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (
        file === filePath &&
        !started &&
        typeof data === 'string' &&
        data.includes('"status": "sending"')
      ) {
        started = true;
        cancelResult = await canceller.service.cancel(id).then(
          (result) => result,
          (err: unknown) => err,
        );
      }
      return original(file, data, options as { flag?: string });
    });
    try {
      const outcome = await checker.service.checkAndSend();
      const sent = await checker.service.list({ status: 'sent' });
      const cancelled = isCancelled(cancelResult);
      expect(cancelled && (outcome.sent > 0 || sent.length > 0)).toBe(false);
      expect(checker.smtp.sendEmail.mock.calls.length > 0 && cancelled).toBe(false);
      expect(cancelled || sent.length === 1).toBe(true);
    } finally {
      spy.mockRestore();
      await fs.rm(queueDir, { recursive: true, force: true });
    }
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
    first.smtp.sendEmail.mockReturnValue(pending);
    let sending: Promise<unknown> = Promise.resolve();
    try {
      await writeDue(queueDir, id, 'pending');
      sending = first.service.checkAndSend();
      await vi.waitFor(() => {
        expect(first.smtp.sendEmail).toHaveBeenCalledTimes(1);
      });
      const before = await mtimeOf(lockPath);
      await vi.advanceTimersByTimeAsync(2 * STALE_LOCK_MS);
      await vi.waitFor(async () => {
        expect(await mtimeOf(lockPath)).toBeGreaterThan(before);
      });
      const second = createService(queueDir);
      await second.service.checkAndSend();
      releaseSend({ messageId: '<scheduled@example.com>' });
      await sending;
      const calls =
        first.smtp.sendEmail.mock.calls.length + second.smtp.sendEmail.mock.calls.length;
      const sent = await first.service.list({ status: 'sent' });
      expect(calls).toBe(1);
      expect(sent).toHaveLength(1);
    } finally {
      releaseSend({ messageId: '<scheduled@example.com>' });
      await sending.catch(() => undefined);
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
});
