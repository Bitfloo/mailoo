import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createService } from '../test-support/scheduler-fixtures.js';

const SEND_AT = '2028-01-16T00:00:00.000Z';
const HTML_BODY = { body: '<p>The figures are attached.</p>', html: true };

/**
 * Schedules one email with `content` as its body and html flag, IMAP accepting the draft
 * as message 42 in Drafts, then runs a check after its send time. schedule() refuses a send
 * time that is not in the future, so the clock sits a day before the send time while scheduling.
 */
async function scheduleWithDraft(
  content: { body: string; html?: boolean } = HTML_BODY,
): Promise<ReturnType<typeof createService>> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
  const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-draft-'));
  try {
    const under = createService(queueDir);
    under.imap.saveDraft.mockResolvedValue({ id: 42, mailbox: 'Drafts' });
    await under.service.schedule('personal', {
      to: ['to@example.com'],
      cc: ['cc@example.com'],
      bcc: ['bcc@example.com'],
      subject: 'Quarterly numbers',
      ...content,
      sendAt: SEND_AT,
    });
    vi.setSystemTime(new Date('2028-01-17T00:00:00.000Z'));
    await under.service.checkAndSend();
    return under;
  } finally {
    await fs.rm(queueDir, { recursive: true, force: true });
  }
}

describe('scheduled email IMAP draft', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should save a draft with the scheduled recipients, body, cc and html flag under a subject naming the send time', async () => {
    const { imap } = await scheduleWithDraft();
    expect(imap.saveDraft.mock.calls).toEqual([
      [
        'personal',
        {
          to: ['to@example.com'],
          subject: `[Scheduled: ${new Date(SEND_AT).toLocaleString()}] Quarterly numbers`,
          body: '<p>The figures are attached.</p>',
          cc: ['cc@example.com'],
          html: true,
        },
      ],
    ]);
  });

  it('should save the draft with no html flag when the email is scheduled without one', async () => {
    const { imap } = await scheduleWithDraft({ body: 'The figures are attached.' });
    expect(imap.saveDraft.mock.calls).toEqual([
      [
        'personal',
        {
          to: ['to@example.com'],
          subject: `[Scheduled: ${new Date(SEND_AT).toLocaleString()}] Quarterly numbers`,
          body: 'The figures are attached.',
          cc: ['cc@example.com'],
          html: undefined,
        },
      ],
    ]);
  });

  it('should delete the draft from the mailbox IMAP saved it in once the email is sent', async () => {
    const { imap, smtp } = await scheduleWithDraft();
    expect({
      sends: smtp.sendEmail.mock.calls.length,
      deletes: imap.deleteEmail.mock.calls,
    }).toEqual({ sends: 1, deletes: [['personal', '42', 'Drafts']] });
  });
});
