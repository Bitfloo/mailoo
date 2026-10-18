import fs from 'node:fs/promises';
import path from 'node:path';

import withFullDisk from '../test-support/full-disk.js';
import {
  createService,
  pendingRecord,
  SCHEDULE_CLAIM_SUFFIX,
  withDueQueue,
  withHeldFirstRead,
} from '../test-support/scheduler-fixtures.js';
import type { ScheduledEmail } from '../types/index.js';

/**
 * Fails the next `count` renames into sentDir. Unlike a read-only sent/, this holds when the
 * tests run as root.
 */
async function withNextMoveFailing(
  sentDir: string,
  body: () => Promise<void>,
  count = 1,
): Promise<void> {
  const original = fs.rename.bind(fs);
  let left = count;
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (left > 0 && path.dirname(String(to)) === sentDir) {
      left -= 1;
      throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' });
    }
    return original(from, to);
  });
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
}

describe('retried and delivered sends', () => {
  // `mailoo scheduler list` prints sentAt for every delivered email.
  it('should record when SMTP accepted the email and the Message-ID it returned', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
    try {
      await withDueQueue(async ({ queueDir, id, sentDir }) => {
        const { service } = createService(queueDir);
        await service.checkAndSend();
        const sent = JSON.parse(
          await fs.readFile(path.join(sentDir, `${id}.json`), 'utf8'),
        ) as ScheduledEmail;
        expect({ sentAt: sent.sentAt, sentMessageId: sent.sentMessageId }).toEqual({
          sentAt: '2028-01-15T00:00:00.000Z',
          sentMessageId: '<scheduled@example.com>',
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('should not send again when the sent record cannot be written after SMTP accepted', async () => {
    await withDueQueue(async ({ queueDir, sentDir }) => {
      const { service, smtp } = createService(queueDir);
      await withNextMoveFailing(sentDir, async () => {
        await service.checkAndSend();
      });
      await service.checkAndSend();
      expect(smtp.sendEmail.mock.calls).toHaveLength(1);
    });
  });

  it('should count a delivered email as sent when its sent record cannot be written', async () => {
    await withDueQueue(async ({ queueDir, id, sentDir }) => {
      const { service } = createService(queueDir);
      let result = { sent: 0, failed: 0, deferred: 0, errors: [] as string[] };
      await withNextMoveFailing(sentDir, async () => {
        result = await service.checkAndSend();
      });
      // The file name tells the operator which queue entry to inspect.
      const prefix = new RegExp(
        `^${id}\\.json: sent, but the queue record was not updated: EACCES`,
      );
      expect({ sent: result.sent, failed: result.failed, errors: result.errors }).toEqual({
        sent: 1,
        failed: 0,
        errors: [expect.stringMatching(prefix)],
      });
    });
  });

  it('should report a delivered email whose sent record hit a full disk', async () => {
    await withDueQueue(async ({ queueDir }) => {
      const { service } = createService(queueDir);
      let errors: string[] = [];
      await withFullDisk(
        (data) => data.includes('"status": "sent"'),
        async () => {
          ({ errors } = await service.checkAndSend());
        },
      );
      expect(errors).toEqual([
        expect.stringMatching(/sent, but the queue record was not updated: ENOSPC/),
      ]);
    });
  });

  // At least once, not exactly once: with neither the sent record nor the move, the record still says sending.
  it('should send again on the next check when neither the sent record nor the move into sent/ succeeded', async () => {
    await withDueQueue(async ({ queueDir, sentDir }) => {
      const { service, smtp } = createService(queueDir);
      await withNextMoveFailing(sentDir, async () => {
        await withFullDisk(
          (data) => data.includes('"status": "sent"'),
          async () => {
            await service.checkAndSend();
          },
        );
      });
      await service.checkAndSend();
      expect(smtp.sendEmail.mock.calls).toHaveLength(2);
    });
  });

  it('should not send again when a check that read the record before delivery claims it after', async () => {
    await withDueQueue(async ({ queueDir, pendingPath, sentDir }) => {
      const late = createService(queueDir);
      const early = createService(queueDir);
      // The move into sent/ fails, so the delivered record stays in the queue directory.
      await withNextMoveFailing(sentDir, async () => {
        await withHeldFirstRead(pendingPath, async (held, resume) => {
          const stale = late.service.checkAndSend();
          await held;
          await early.service.checkAndSend();
          resume();
          await stale;
        });
      });
      const sends = late.smtp.sendEmail.mock.calls.length + early.smtp.sendEmail.mock.calls.length;
      const leftInQueue = await fs.readFile(pendingPath, 'utf8').then(
        (text) => (JSON.parse(text) as ScheduledEmail).status,
        () => 'moved into sent/',
      );
      expect({ sends, leftInQueue }).toEqual({ sends: 1, leftInQueue: 'sent' });
    });
  });

  it('should not send again when the disk fills while recording a delivered email', async () => {
    await withDueQueue(async ({ queueDir }) => {
      const { service, smtp } = createService(queueDir);
      await withFullDisk(
        (data) => data.includes('"status": "sent"'),
        async () => {
          await service.checkAndSend();
        },
      );
      await service.checkAndSend();
      expect(smtp.sendEmail.mock.calls).toHaveLength(1);
    });
  });

  it('should move a record that already says sent into sent/ without sending it', async () => {
    await withDueQueue(async ({ queueDir, id, pendingPath, sentDir }) => {
      // The state a crash leaves between recording the send and moving the file.
      const record = { ...pendingRecord(id, '2020-01-01T00:00:00Z'), status: 'sent', attempts: 1 };
      await fs.writeFile(pendingPath, JSON.stringify(record));
      const { service, smtp } = createService(queueDir);
      const result = await service.checkAndSend();
      const moved = JSON.parse(
        await fs.readFile(path.join(sentDir, `${id}.json`), 'utf8'),
      ) as ScheduledEmail;
      expect({ result, status: moved.status, sends: smtp.sendEmail.mock.calls.length }).toEqual({
        result: { sent: 0, failed: 0, deferred: 0, errors: [] },
        status: 'sent',
        sends: 0,
      });
    });
  });

  // Sent back to the retry path, a delivered email would go out again on the next check.
  it('should leave a record that says sent unchanged and unsent when its move into sent/ fails', async () => {
    await withDueQueue(async ({ queueDir, id, pendingPath, sentDir }) => {
      const record = { ...pendingRecord(id, '2020-01-01T00:00:00Z'), status: 'sent', attempts: 1 };
      await fs.writeFile(pendingPath, JSON.stringify(record));
      const { service, smtp } = createService(queueDir);
      let first = {};
      // One failed move per check: the record must survive both.
      await withNextMoveFailing(
        sentDir,
        async () => {
          first = await service.checkAndSend();
          await service.checkAndSend();
        },
        2,
      );
      const kept = JSON.parse(await fs.readFile(pendingPath, 'utf8')) as ScheduledEmail;
      expect({
        sends: smtp.sendEmail.mock.calls.length,
        first,
        status: kept.status,
        attempts: kept.attempts,
      }).toEqual({
        sends: 0,
        first: { sent: 0, failed: 0, deferred: 0, errors: [] },
        status: 'sent',
        attempts: 1,
      });
    });
  });

  // The sent record is the commit point, so its error is the one that explains a resend.
  it('should report the sent record error when the move into sent/ fails too', async () => {
    await withDueQueue(async ({ queueDir, sentDir }) => {
      const { service } = createService(queueDir);
      let errors: string[] = [];
      await withNextMoveFailing(sentDir, async () => {
        await withFullDisk(
          (data) => data.includes('"status": "sent"'),
          async () => {
            ({ errors } = await service.checkAndSend());
          },
        );
      });
      expect(errors).toEqual([
        expect.stringMatching(/sent, but the queue record was not updated: ENOSPC/),
      ]);
    });
  });

  it('should leave a record that says sent in place while its sender still holds the claim', async () => {
    await withDueQueue(async ({ queueDir, id, pendingPath }) => {
      // The sender wrote the commit record and has not renamed it yet.
      const record = { ...pendingRecord(id, '2020-01-01T00:00:00Z'), status: 'sent', attempts: 1 };
      await fs.writeFile(pendingPath, JSON.stringify(record));
      await fs.writeFile(path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`), 'held', {
        flag: 'wx',
      });
      const { service } = createService(queueDir);
      await service.checkAndSend();
      await expect(fs.readFile(pendingPath, 'utf8')).resolves.toContain('"sent"');
    });
  });
});
