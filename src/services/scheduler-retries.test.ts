import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import withFullDisk from '../test-support/full-disk.js';
import queueId from '../test-support/queue-id.js';
import {
  createService,
  MAX_ATTEMPTS,
  pendingRecord,
  SCHEDULE_CLAIM_SUFFIX,
  STALE_LOCK_MS,
} from '../test-support/scheduler-fixtures.js';
import type { ScheduledEmail } from '../types/index.js';

/**
 * Holds the first read of filePath until resume() runs, so that reader goes
 * on with bytes another check has made stale in the meantime.
 */
async function withHeldFirstRead(
  filePath: string,
  body: (held: Promise<void>, resume: () => void) => Promise<void>,
): Promise<void> {
  let markHeld: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  let resume: () => void = () => {};
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let first = true;
  const original = fs.readFile.bind(fs);
  const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
    const content = await original(file, options as { encoding: 'utf8' });
    if (file === filePath && first) {
      first = false;
      markHeld();
      await resumed;
    }
    return content;
  });
  try {
    await body(held, resume);
  } finally {
    resume();
    spy.mockRestore();
  }
}

describe('retried and delivered sends', () => {
  async function withDueQueue(
    body: (paths: {
      queueDir: string;
      id: string;
      pendingPath: string;
      sentDir: string;
    }) => Promise<void>,
  ): Promise<void> {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-retry-'));
    const id = queueId(7);
    const pendingPath = path.join(queueDir, `${id}.json`);
    const sentDir = path.join(queueDir, 'sent');
    try {
      await fs.writeFile(pendingPath, JSON.stringify(pendingRecord(id, '2020-01-01T00:00:00Z')));
      await body({ queueDir, id, pendingPath, sentDir });
    } finally {
      await fs.chmod(sentDir, 0o700).catch(() => undefined);
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  }

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

  // Root ignores directory permissions, so the unwritable sent/ cannot be simulated.
  it.skipIf(process.getuid?.() === 0)(
    'should not send again when the sent record cannot be written after SMTP accepted',
    async () => {
      await withDueQueue(async ({ queueDir, sentDir }) => {
        const { service, smtp } = createService(queueDir);
        await fs.mkdir(sentDir, { recursive: true });
        await fs.chmod(sentDir, 0o500);
        await service.checkAndSend();
        await service.checkAndSend();
        expect(smtp.sendEmail.mock.calls).toHaveLength(1);
      });
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'should count a delivered email as sent when its sent record cannot be written',
    async () => {
      await withDueQueue(async ({ queueDir, id, sentDir }) => {
        const { service } = createService(queueDir);
        await fs.mkdir(sentDir, { recursive: true });
        await fs.chmod(sentDir, 0o500);
        const result = await service.checkAndSend();
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
    },
  );

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
  it.skipIf(process.getuid?.() === 0)(
    'should send again on the next check when neither the sent record nor the move into sent/ succeeded',
    async () => {
      await withDueQueue(async ({ queueDir, sentDir }) => {
        const { service, smtp } = createService(queueDir);
        await fs.mkdir(sentDir, { recursive: true });
        await fs.chmod(sentDir, 0o500);
        await withFullDisk(
          (data) => data.includes('"status": "sent"'),
          async () => {
            await service.checkAndSend();
          },
        );
        await service.checkAndSend();
        expect(smtp.sendEmail.mock.calls).toHaveLength(2);
      });
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'should not send again when a check that read the record before delivery claims it after',
    async () => {
      await withDueQueue(async ({ queueDir, pendingPath, sentDir }) => {
        // The move into sent/ fails, so the delivered record stays in the queue directory.
        await fs.mkdir(sentDir, { recursive: true });
        await fs.chmod(sentDir, 0o500);
        const late = createService(queueDir);
        const early = createService(queueDir);
        await withHeldFirstRead(pendingPath, async (held, resume) => {
          const stale = late.service.checkAndSend();
          await held;
          await early.service.checkAndSend();
          resume();
          await stale;
        });
        const sends =
          late.smtp.sendEmail.mock.calls.length + early.smtp.sendEmail.mock.calls.length;
        expect(sends).toBe(1);
      });
    },
  );

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
      await service.checkAndSend();
      const moved = JSON.parse(
        await fs.readFile(path.join(sentDir, `${id}.json`), 'utf8'),
      ) as ScheduledEmail;
      expect({ status: moved.status, sends: smtp.sendEmail.mock.calls.length }).toEqual({
        status: 'sent',
        sends: 0,
      });
    });
  });

  // Sent back to the retry path, a delivered email would go out again on the next check.
  it.skipIf(process.getuid?.() === 0)(
    'should leave a record that says sent unchanged and unsent when its move into sent/ fails',
    async () => {
      await withDueQueue(async ({ queueDir, id, pendingPath, sentDir }) => {
        const record = {
          ...pendingRecord(id, '2020-01-01T00:00:00Z'),
          status: 'sent',
          attempts: 1,
        };
        await fs.writeFile(pendingPath, JSON.stringify(record));
        await fs.mkdir(sentDir, { recursive: true });
        await fs.chmod(sentDir, 0o500);
        const { service, smtp } = createService(queueDir);
        const first = await service.checkAndSend();
        await service.checkAndSend();
        const kept = JSON.parse(await fs.readFile(pendingPath, 'utf8')) as ScheduledEmail;
        expect({
          sends: smtp.sendEmail.mock.calls.length,
          errors: first.errors,
          status: kept.status,
          attempts: kept.attempts,
        }).toEqual({ sends: 0, errors: [], status: 'sent', attempts: 1 });
      });
    },
  );

  // The sent record is the commit point, so its error is the one that explains a resend.
  it.skipIf(process.getuid?.() === 0)(
    'should report the sent record error when the move into sent/ fails too',
    async () => {
      await withDueQueue(async ({ queueDir, sentDir }) => {
        const { service } = createService(queueDir);
        await fs.mkdir(sentDir, { recursive: true });
        await fs.chmod(sentDir, 0o500);
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
    },
  );

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
