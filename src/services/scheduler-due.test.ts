import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import withFullDisk from '../test-support/full-disk.js';
import queueId from '../test-support/queue-id.js';
import {
  createService,
  daysFromNow,
  jsonNames,
  pendingRecord,
  SCHEDULE_CLAIM_SUFFIX,
} from '../test-support/scheduler-fixtures.js';
import type { ScheduledEmail } from '../types/index.js';

describe('due boundary', () => {
  it('should send an email due now and hold one due 1 ms later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-due-'));
    try {
      const now = Date.now();
      await fs.writeFile(
        path.join(queueDir, `${queueId(1)}.json`),
        JSON.stringify(pendingRecord(queueId(1), new Date(now).toISOString())),
      );
      await fs.writeFile(
        path.join(queueDir, `${queueId(2)}.json`),
        JSON.stringify(pendingRecord(queueId(2), new Date(now + 1).toISOString())),
      );
      const { service } = createService(queueDir);
      await service.checkAndSend();
      expect(await jsonNames(path.join(queueDir, 'sent'))).toEqual([`${queueId(1)}.json`]);
    } finally {
      vi.useRealTimers();
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});

// The loop logs every failed count at warning, so a skipped file counted as failed warns each minute.
describe('emails a check skips', () => {
  const quiet = { sent: 0, failed: 0, deferred: 0, errors: [] };

  it('should report nothing when the queue holds only a future-dated email', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-future-'));
    try {
      await fs.writeFile(
        path.join(queueDir, `${queueId(1)}.json`),
        JSON.stringify(pendingRecord(queueId(1), daysFromNow(1))),
      );
      const { service } = createService(queueDir);
      expect(await service.checkAndSend()).toEqual(quiet);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('should report nothing when another check holds a live claim on the due email', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-held-'));
    const id = queueId(1);
    try {
      await fs.writeFile(
        path.join(queueDir, `${id}.json`),
        JSON.stringify(pendingRecord(id, '2020-01-01T00:00:00.000Z')),
      );
      await fs.writeFile(path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`), 'held', {
        flag: 'wx',
      });
      const { service } = createService(queueDir);
      expect(await service.checkAndSend()).toEqual(quiet);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  // Status writes go to the file named by the record's id, so a record under another
  // file name would never be marked sent and would go out again on every check.
  it('should not send or list a record whose id differs from its file name', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-renamed-'));
    try {
      await fs.writeFile(
        path.join(queueDir, `${queueId(2)}.json`),
        JSON.stringify(pendingRecord(queueId(1), '2020-01-01T00:00:00.000Z')),
      );
      const { service, smtp } = createService(queueDir);
      expect({
        result: await service.checkAndSend(),
        sends: smtp.sendEmail.mock.calls.length,
        listed: await service.list({ status: 'all' }),
      }).toEqual({ result: quiet, sends: 0, listed: [] });
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('should not move a sent record whose id differs from its file name', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-renamed-sent-'));
    try {
      await fs.writeFile(
        path.join(queueDir, `${queueId(2)}.json`),
        JSON.stringify({
          ...pendingRecord(queueId(1), '2020-01-01T00:00:00.000Z'),
          status: 'sent',
        }),
      );
      const { service } = createService(queueDir);
      await service.checkAndSend();
      expect({
        queued: await jsonNames(queueDir),
        sent: await jsonNames(path.join(queueDir, 'sent')),
      }).toEqual({ queued: [`${queueId(2)}.json`], sent: [] });
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});

describe('successful send', () => {
  it('removes the pending queue file after SMTP accepts the email', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-sent-'));
    const id = queueId(1);
    const pendingPath = path.join(queueDir, `${id}.json`);
    try {
      await fs.writeFile(pendingPath, JSON.stringify(pendingRecord(id, '2020-01-01T00:00:00Z')));
      const { service } = createService(queueDir);
      await service.checkAndSend();
      await expect(fs.access(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});

describe('full disk', () => {
  it('keeps the queue record readable when the disk fills while recording a send attempt', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-enospc-'));
    const id = queueId(1);
    const pendingPath = path.join(queueDir, `${id}.json`);
    try {
      await fs.writeFile(pendingPath, JSON.stringify(pendingRecord(id, '2020-01-01T00:00:00Z')));
      const { service } = createService(queueDir);
      await withFullDisk(
        (data) => data.includes('"status"'),
        async () => {
          await service.checkAndSend();
        },
      );
      const saved = JSON.parse(await fs.readFile(pendingPath, 'utf8')) as ScheduledEmail;
      expect(saved).toMatchObject({ id, status: 'pending', attempts: 0 });
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});
