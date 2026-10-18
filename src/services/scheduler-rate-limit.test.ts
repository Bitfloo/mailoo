import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SendMailOptions } from 'nodemailer';

import RateLimiter from '../safety/rate-limiter.js';
import queueId from '../test-support/queue-id.js';
import { jsonNames, pendingRecord, SchedulerService } from '../test-support/scheduler-fixtures.js';
import type { ScheduledEmail } from '../types/index.js';

const { default: SmtpService } = await import('./smtp.service.js');

/** The real SmtpService and RateLimiter; only the SMTP socket is fake. */
function smtpBackedScheduler(
  queueDir: string,
  options: { perMinute?: number; sent?: SendMailOptions[] } = {},
): InstanceType<typeof SchedulerService> {
  const connections = {
    getAccount: () => ({
      name: 'personal',
      email: 'user@example.com',
      username: 'user@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
    }),
    getSmtpTransport: async () => ({
      sendMail: async (mail: SendMailOptions) => {
        options.sent?.push(mail);
        return { messageId: '<accepted@example.com>' };
      },
    }),
  };
  const limiter = new RateLimiter(options.perMinute ?? 10);
  const smtp = new SmtpService(connections as never, limiter, {} as never, false);
  return new SchedulerService(smtp, { deleteEmail: vi.fn() } as never, queueDir);
}

describe('rate-limited sends', () => {
  beforeEach(() => {
    // A pinned clock keeps the one-per-minute bucket from refilling between checks.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function withLimitedQueue(
    body: (queueDir: string, service: InstanceType<typeof SchedulerService>) => Promise<void>,
  ): Promise<void> {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-limit-'));
    try {
      await Promise.all(
        [queueId(0), queueId(1)].map(async (id) =>
          fs.writeFile(
            path.join(queueDir, `${id}.json`),
            JSON.stringify(pendingRecord(id, '2020-01-01T00:00:00.000Z')),
          ),
        ),
      );
      await body(queueDir, smtpBackedScheduler(queueDir, { perMinute: 1 }));
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  }

  it('should keep a rate-limited email pending, its attempts unchanged and the limit as its error', async () => {
    await withLimitedQueue(async (queueDir, service) => {
      await service.checkAndSend();
      await service.checkAndSend();
      await service.checkAndSend();
      const [left] = await jsonNames(queueDir);
      const record = JSON.parse(
        await fs.readFile(path.join(queueDir, left ?? 'missing.json'), 'utf8'),
      ) as ScheduledEmail;
      expect({
        status: record.status,
        attempts: record.attempts,
        lastError: record.lastError,
      }).toEqual({
        status: 'pending',
        attempts: 0,
        lastError: expect.stringMatching(/^Rate limit exceeded for account "personal"/),
      });
    });
  });

  it('should count a rate-limited email as deferred rather than failed', async () => {
    await withLimitedQueue(async (_queueDir, service) => {
      const result = await service.checkAndSend();
      expect(result).toEqual({ sent: 1, failed: 0, deferred: 1, errors: [] });
    });
  });
});

describe('scheduled email content', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should deliver the stored recipients, subject, body, html flag, cc and bcc', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-content-'));
    const sent: SendMailOptions[] = [];
    try {
      const service = smtpBackedScheduler(queueDir, { sent });
      await service.schedule('personal', {
        to: ['to@example.com'],
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        subject: 'Quarterly numbers',
        body: '<p>The figures are attached.</p>',
        html: true,
        sendAt: '2028-01-16T00:00:00.000Z',
      });
      vi.setSystemTime(new Date('2028-01-17T00:00:00.000Z'));
      await service.checkAndSend();
      expect(
        sent.map(({ to, cc, bcc, subject, html, text }) => ({ to, cc, bcc, subject, html, text })),
      ).toEqual([
        {
          to: 'to@example.com',
          cc: 'cc@example.com',
          bcc: 'bcc@example.com',
          subject: 'Quarterly numbers',
          html: '<p>The figures are attached.</p>',
          text: undefined,
        },
      ]);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});

describe('scheduled replies', () => {
  it('should send the stored In-Reply-To and References headers', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-reply-'));
    const id = queueId(3);
    const sent: SendMailOptions[] = [];
    try {
      const record: ScheduledEmail = {
        ...pendingRecord(id, '2020-01-01T00:00:00.000Z'),
        subject: 'Re: Hello',
        inReplyTo: '<parent@example.com>',
        references: ['<root@example.com>', '<parent@example.com>'],
      };
      await fs.writeFile(path.join(queueDir, `${id}.json`), JSON.stringify(record));
      await smtpBackedScheduler(queueDir, { sent }).checkAndSend();
      expect(sent.map((mail) => [mail.inReplyTo, mail.references])).toEqual([
        ['<parent@example.com>', '<root@example.com> <parent@example.com>'],
      ]);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});
