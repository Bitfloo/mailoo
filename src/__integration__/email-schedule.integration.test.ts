import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Email, ScheduledEmail } from '../types/index.js';
import {
  buildTestAccount,
  createTestServices,
  TEST_ACCOUNT_NAME,
  TEST_EMAIL,
  type TestServices,
  waitForDelivery,
} from './helpers/index.js';

describe('scheduled mail on GreenMail', () => {
  let services: TestServices;
  let stateHome: string;

  beforeAll(async () => {
    stateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-it-'));
    vi.stubEnv('XDG_STATE_HOME', stateHome);
    services = createTestServices(buildTestAccount());
    // Cancel moves the draft to Trash, so without Trash this file passed only after another file
    // made it. A rejection means GreenMail kept the mailbox from an earlier run in this container.
    await Promise.allSettled(
      ['Drafts', 'Trash'].map((mailbox) =>
        services.imapService.createMailbox(TEST_ACCOUNT_NAME, mailbox),
      ),
    );
  });

  afterAll(async () => {
    await services.connections.closeAll();
    vi.unstubAllEnvs();
    await fs.rm(stateHome, { recursive: true, force: true });
  });

  it('keeps the draft when the schedule id is not a queue file name', async () => {
    vi.resetModules();
    const xdg = await import('../config/xdg.js');
    expect(xdg.SCHEDULED_DIR.startsWith(stateHome)).toBe(true);
    const { default: SchedulerService } = await import('../services/scheduler.service.js');
    const scheduler = new SchedulerService(services.smtpService, services.imapService);
    const marker = `queue-${Date.now()}`;
    const scheduled = await scheduler.schedule(TEST_ACCOUNT_NAME, {
      to: ['bob@localhost'],
      subject: marker,
      body: 'See you then.',
      sendAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(scheduled.draftMessageId).toBeTruthy();
    expect(scheduled.draftMailbox).toBeTruthy();
    const draftId = scheduled.draftMessageId ?? '';
    const draftMailbox = scheduled.draftMailbox ?? '';
    const before = await services.imapService.getEmail(TEST_ACCOUNT_NAME, draftId, draftMailbox);
    expect(before.subject).toContain(marker);

    await expect(scheduler.cancel('../canary/secret')).rejects.toThrow(/id/);
    const still = await services.imapService.getEmail(TEST_ACCOUNT_NAME, draftId, draftMailbox);
    expect(still.subject).toContain(marker);

    const result = await scheduler.cancel(scheduled.id);
    expect(result.cancelled).toBe(true);
    await expect(
      services.imapService.getEmail(TEST_ACCOUNT_NAME, draftId, draftMailbox),
    ).rejects.toThrow();
    await expect(
      fs.readFile(path.join(xdg.SCHEDULED_DIR, `${scheduled.id}.json`), 'utf8'),
    ).rejects.toThrow();
  });

  async function deliverDue(
    queueDir: string,
    options: { subject: string; inReplyTo?: string; references?: string[] },
  ): Promise<{ id: string; email: Email }> {
    const { default: SchedulerService } = await import('../services/scheduler.service.js');
    const scheduler = new SchedulerService(services.smtpService, services.imapService, queueDir);
    const scheduled = await scheduler.schedule(TEST_ACCOUNT_NAME, {
      to: [TEST_EMAIL],
      body: 'Due now.',
      sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ...options,
    });
    // schedule() refuses a past send_at, so the stored record is moved back to make it due.
    const queuePath = path.join(queueDir, `${scheduled.id}.json`);
    const stored = JSON.parse(await fs.readFile(queuePath, 'utf8')) as ScheduledEmail;
    await fs.writeFile(
      queuePath,
      JSON.stringify({ ...stored, sendAt: '2020-01-01T00:00:00.000Z' }),
    );
    const result = await scheduler.checkAndSend();
    expect(result.errors).toEqual([]);
    await waitForDelivery();
    const listed = await services.imapService.listEmails(TEST_ACCOUNT_NAME, {
      subject: options.subject,
    });
    const id = listed.items[0]?.id ?? '';
    return {
      id: scheduled.id,
      email: await services.imapService.getEmail(TEST_ACCOUNT_NAME, id, 'INBOX'),
    };
  }

  it('should deliver a scheduled email with a Message-ID built from its schedule id', async () => {
    const subject = `message-id-${Date.now()}`;
    const { id, email } = await deliverDue(path.join(stateHome, 'queue-message-id'), { subject });
    expect(email.messageId).toBe(`<${id}@localhost>`);
  });

  it('should deliver a scheduled reply with its In-Reply-To and References headers', async () => {
    const subject = `Re: thread-${Date.now()}`;
    const { email } = await deliverDue(path.join(stateHome, 'queue-reply'), {
      subject,
      inReplyTo: '<parent@localhost>',
      references: ['<root@localhost>', '<parent@localhost>'],
    });
    // Raw headers: GreenMail leaves In-Reply-To out of ENVELOPE, so email.inReplyTo stays empty here.
    expect([email.headers['in-reply-to'], email.headers.references]).toEqual([
      '<parent@localhost>',
      '<root@localhost> <parent@localhost>',
    ]);
  });
});
