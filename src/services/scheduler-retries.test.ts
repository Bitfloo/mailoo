import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createService,
  MAX_ATTEMPTS,
  pendingRecord,
  SCHEDULE_CLAIM_SUFFIX,
  STALE_LOCK_MS,
  withDueQueue,
  withHeldFirstRead,
} from '../test-support/scheduler-fixtures.js';
import type { ScheduledEmail } from '../types/index.js';

describe('retried and delivered sends', () => {
  it('should send every attempt of one schedule with the same Message-ID', async () => {
    await withDueQueue(async ({ queueDir, id }) => {
      const { service, smtp } = createService(queueDir);
      smtp.sendEmail.mockRejectedValueOnce(new Error('421 try again later'));
      await service.checkAndSend();
      await service.checkAndSend();
      const ids = smtp.sendEmail.mock.calls.map(
        (call) => (call[1] as { messageId?: string }).messageId,
      );
      expect(ids).toEqual([`<${id}@example.com>`, `<${id}@example.com>`]);
    });
  });

  it('should mark an email failed after three rejected sends', async () => {
    await withDueQueue(async ({ queueDir, pendingPath }) => {
      const { service, smtp } = createService(queueDir);
      smtp.sendEmail.mockRejectedValue(new Error('550 mailbox unavailable'));
      await service.checkAndSend();
      await service.checkAndSend();
      await service.checkAndSend();
      await service.checkAndSend();
      const record = JSON.parse(await fs.readFile(pendingPath, 'utf8')) as ScheduledEmail;
      expect({
        sends: smtp.sendEmail.mock.calls.length,
        status: record.status,
        attempts: record.attempts,
        lastError: record.lastError,
      }).toEqual({ sends: 3, status: 'failed', attempts: 3, lastError: '550 mailbox unavailable' });
    });
  });

  it('should mark a record failed without sending when it already used three attempts', async () => {
    await withDueQueue(async ({ queueDir, id, pendingPath }) => {
      // A process that died during its third send leaves this record and a stale claim.
      const crashed = {
        ...pendingRecord(id, '2020-01-01T00:00:00Z'),
        status: 'sending',
        attempts: 3,
      };
      await fs.writeFile(pendingPath, JSON.stringify(crashed));
      const lockPath = path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
      await fs.writeFile(lockPath, 'crashed', { flag: 'wx' });
      const crashedAt = new Date(Date.now() - STALE_LOCK_MS - 1000);
      await fs.utimes(lockPath, crashedAt, crashedAt);
      const { service, smtp } = createService(queueDir);
      const result = await service.checkAndSend();
      const [record] = await service.list({ status: 'all' });
      expect({
        sends: smtp.sendEmail.mock.calls.length,
        failed: result.failed,
        status: record?.status,
        lastError: record?.lastError,
      }).toEqual({
        sends: 0,
        failed: 1,
        status: 'failed',
        lastError: 'Max retry attempts exceeded',
      });
    });
  });

  // Sending the record read before the claim would undo another check's attempt count,
  // so a failing email would be retried past its attempt limit.
  it('should count the attempts another check recorded after this one first read the record', async () => {
    await withDueQueue(async ({ queueDir, id, pendingPath, sentDir }) => {
      const { service } = createService(queueDir);
      await withHeldFirstRead(pendingPath, async (held, resume) => {
        const checking = service.checkAndSend();
        await held;
        // Another check failed its second attempt and released its claim.
        const retried = {
          ...pendingRecord(id, '2020-01-01T00:00:00Z'),
          attempts: 2,
          lastError: '421 try again later',
        };
        await fs.writeFile(pendingPath, JSON.stringify(retried));
        resume();
        await checking;
      });
      const sent = JSON.parse(
        await fs.readFile(path.join(sentDir, `${id}.json`), 'utf8'),
      ) as ScheduledEmail;
      expect(sent.attempts).toBe(3);
    });
  });
});

describe('attempt limit in README.md', () => {
  it('should state the attempt limit the scheduler enforces', async () => {
    const readme = await fs.readFile(new URL('../../README.md', import.meta.url), 'utf8');
    const start = readme.indexOf('### Email Scheduling');
    const section = readme.slice(start, readme.indexOf('\n### ', start + 1));
    const counts = [
      ...section.matchAll(/attempted up to \*\*(\d+) times\*\*|its attempts \(at most (\d+)\)/g),
    ].map((match) => Number(match[1] ?? match[2]));
    expect(counts).toEqual([MAX_ATTEMPTS, MAX_ATTEMPTS]);
  });
});
