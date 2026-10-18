import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import queueId from '../test-support/queue-id.js';
import { createService, pendingRecord } from '../test-support/scheduler-fixtures.js';

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

describe('send_at horizon', () => {
  beforeEach(() => {
    // Faking timers as well hangs the async queue writes.
    // 2028 is a leap year, so 2028-01-15 plus 366 days is 2029-01-15.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function scheduleIn(queueDir: string, sendAt: string) {
    const { service } = createService(queueDir);
    return service.schedule('personal', {
      to: ['user@example.com'],
      subject: 'Hello',
      body: 'Body',
      sendAt,
    });
  }

  it('accepts a send_at exactly 366 days ahead', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-horizon-'));
    try {
      const scheduled = await scheduleIn(queueDir, '2029-01-15T00:00:00.000Z');
      expect(scheduled.sendAt).toBe('2029-01-15T00:00:00.000Z');
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('rejects a send_at 366 days and 1 ms ahead', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-horizon-'));
    try {
      await expect(scheduleIn(queueDir, '2029-01-15T00:00:00.001Z')).rejects.toThrow(
        'send_at must be within 366 days',
      );
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
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

describe('unreadable send times', () => {
  it('sends a pending email whose send time is not a date', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-bad-date-'));
    const id = queueId(1);
    const pendingPath = path.join(queueDir, `${id}.json`);
    const sentPath = path.join(queueDir, 'sent', `${id}.json`);
    try {
      await fs.writeFile(pendingPath, JSON.stringify(pendingRecord(id, 'not-a-date')));
      const { service } = createService(queueDir);
      const result = await service.checkAndSend();
      expect(result.sent).toBe(1);
      await expect(fs.access(sentPath)).resolves.toBeUndefined();
      await expect(fs.access(pendingPath)).rejects.toThrow();
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});
