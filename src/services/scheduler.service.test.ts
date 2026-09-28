import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ScheduledEmail } from '../types/index.js';

const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-'));
vi.stubEnv('XDG_STATE_HOME', stateHome);

const { default: SchedulerService } = await import('./scheduler.service.js');

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

describe('SchedulerService queue files', () => {
  afterAll(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateHome, { recursive: true, force: true });
  });

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
