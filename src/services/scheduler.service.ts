/**
 * Scheduler service — JSON file-based email scheduling queue.
 *
 * Manages scheduled emails with a local file queue.
 * Source of truth is the JSON files in XDG state directory.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { SCHEDULED_DIR } from '../config/xdg.js';
import { recipientEmail, validateInputLength } from '../safety/validation.js';
import type { ScheduledEmail } from '../types/index.js';
import type ImapService from './imap.service.js';
import type SmtpService from './smtp.service.js';

/** Max age (ms) for "sending" status before resetting to "pending" */
const STALE_LOCK_MS = 5 * 60 * 1000;

/** Max retry attempts before marking as "failed" */
const MAX_ATTEMPTS = 3;

/** Local queue horizon. Longer delays belong in the mailbox, not on disk. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

export const MAX_SCHEDULE_RECIPIENTS = 50;

export const MAX_SCHEDULE_SUBJECT_CHARS = 998;

export const MAX_SCHEDULE_BODY_CHARS = 5_000_000;

export const MAX_PENDING_SCHEDULES = 100;

/** crypto.randomUUID() values. Anything else is not a safe filename. */
const SCHEDULE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SEND_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function scheduleIdFromFilename(filename: string): string | undefined {
  if (!filename.endsWith('.json')) return undefined;
  const id = filename.slice(0, -'.json'.length);
  if (!SCHEDULE_ID_RE.test(id)) return undefined;
  return id;
}

function queueFile(dir: string, id: string): string {
  if (!SCHEDULE_ID_RE.test(id)) {
    throw new Error('Schedule id is not valid');
  }
  const root = path.resolve(dir);
  const filePath = path.resolve(root, `${id}.json`);
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error('Schedule id is not valid');
  }
  return filePath;
}

function assertAccount(account: string): void {
  /* eslint-disable no-control-regex */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in account names
  const control = /[\u0000-\u001F\u007F]/;
  /* eslint-enable no-control-regex */
  if (account.trim().length === 0 || account.length > 128 || control.test(account)) {
    throw new Error('Account name is not valid');
  }
}

function assertHeaderField(value: string, field: string, max: number): void {
  if (value.includes('\r') || value.includes('\n') || value.includes('\0')) {
    throw new Error(`${field} must not contain line breaks`);
  }
  validateInputLength(value, max, field);
}

function assertAddresses(values: string[] | undefined): void {
  values?.forEach((value) => {
    if (!recipientEmail.safeParse(value).success) {
      throw new Error(`Invalid recipient: ${value}`);
    }
  });
}

function parseSendAt(sendAt: string, now = Date.now()): Date {
  if (sendAt.length > 40 || !SEND_AT_RE.test(sendAt)) {
    throw new Error(`Invalid send_at date: ${sendAt}`);
  }
  const date = new Date(sendAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid send_at date: ${sendAt}`);
  }
  if (date.getTime() <= now) {
    throw new Error('send_at must be in the future');
  }
  if (date.getTime() - now > MAX_SCHEDULE_AHEAD_MS) {
    throw new Error('send_at must be within 366 days');
  }
  return date;
}

export default class SchedulerService {
  private readonly pendingDir: string;

  private readonly sentDir: string;

  constructor(
    private smtpService: SmtpService,
    private imapService: ImapService,
    queueDir: string = SCHEDULED_DIR,
  ) {
    this.pendingDir = queueDir;
    this.sentDir = path.join(queueDir, 'sent');
  }

  // -------------------------------------------------------------------------
  // Schedule a new email
  // -------------------------------------------------------------------------

  async schedule(
    account: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      sendAt: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      inReplyTo?: string;
      references?: string[];
    },
  ): Promise<ScheduledEmail> {
    assertAccount(account);
    const recipients = [...options.to, ...(options.cc ?? []), ...(options.bcc ?? [])];
    if (options.to.length === 0) {
      throw new Error('At least one recipient is required');
    }
    if (recipients.length > MAX_SCHEDULE_RECIPIENTS) {
      throw new Error(`Too many recipients (maximum ${MAX_SCHEDULE_RECIPIENTS})`);
    }
    assertAddresses(options.to);
    assertAddresses(options.cc);
    assertAddresses(options.bcc);
    assertHeaderField(options.subject, 'Subject', MAX_SCHEDULE_SUBJECT_CHARS);
    validateInputLength(options.body, MAX_SCHEDULE_BODY_CHARS, 'Body');
    if (options.inReplyTo !== undefined) {
      assertHeaderField(options.inReplyTo, 'In-Reply-To', MAX_SCHEDULE_SUBJECT_CHARS);
    }
    options.references?.forEach((reference) => {
      assertHeaderField(reference, 'References', MAX_SCHEDULE_SUBJECT_CHARS);
    });
    const sendAtDate = parseSendAt(options.sendAt);

    await this.ensureDirs();
    const pendingNames = await fs.readdir(this.pendingDir);
    const pendingCount = pendingNames.filter((name) => scheduleIdFromFilename(name)).length;
    if (pendingCount >= MAX_PENDING_SCHEDULES) {
      throw new Error(`Too many scheduled emails (maximum ${MAX_PENDING_SCHEDULES})`);
    }

    const scheduled: ScheduledEmail = {
      id: crypto.randomUUID(),
      account,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: options.body,
      html: options.html ?? false,
      sendAt: sendAtDate.toISOString(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      inReplyTo: options.inReplyTo,
      references: options.references,
    };

    // Save IMAP draft (best-effort)
    try {
      const draftResult = await this.imapService.saveDraft(account, {
        to: options.to,
        subject: `[Scheduled: ${sendAtDate.toLocaleString()}] ${options.subject}`,
        body: options.body,
        cc: options.cc,
        html: options.html,
      });
      scheduled.draftMessageId = String(draftResult.id);
      scheduled.draftMailbox = draftResult.mailbox;
    } catch {
      // Draft mirror is best-effort
    }

    await this.writeScheduledFile(scheduled);
    return scheduled;
  }

  // -------------------------------------------------------------------------
  // List scheduled emails
  // -------------------------------------------------------------------------

  async list(
    options: { account?: string; status?: 'pending' | 'sent' | 'failed' | 'all' } = {},
  ): Promise<ScheduledEmail[]> {
    const status = options.status ?? 'pending';
    const emails: ScheduledEmail[] = [];

    // Read pending/sending/failed from main dir
    if (status !== 'sent') {
      const pending = await SchedulerService.readDir(this.pendingDir);
      emails.push(...pending);
    }

    // Read sent from sent/ subdir
    if (status === 'sent' || status === 'all') {
      const sent = await SchedulerService.readDir(this.sentDir);
      emails.push(...sent);
    }

    // Filter by account if specified
    const filtered = options.account ? emails.filter((e) => e.account === options.account) : emails;

    // Filter by status unless "all"
    if (status !== 'all') {
      return filtered.filter((e) => e.status === status);
    }

    return filtered.sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());
  }

  // -------------------------------------------------------------------------
  // Cancel a scheduled email
  // -------------------------------------------------------------------------

  async cancel(scheduleId: string): Promise<{ cancelled: boolean; draftDeleted: boolean }> {
    const filePath = queueFile(this.pendingDir, scheduleId);
    let draftDeleted = false;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const scheduled = JSON.parse(content) as ScheduledEmail;

      if (scheduled.status !== 'pending') {
        throw new Error(`Cannot cancel email with status "${scheduled.status}"`);
      }

      // Delete IMAP draft (best-effort)
      if (scheduled.draftMessageId && scheduled.draftMailbox) {
        try {
          await this.imapService.deleteEmail(
            scheduled.account,
            scheduled.draftMessageId,
            scheduled.draftMailbox,
          );
          draftDeleted = true;
        } catch {
          // Draft deletion is best-effort
        }
      }

      await fs.unlink(filePath);
      return { cancelled: true, draftDeleted };
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        throw new Error(`Scheduled email "${scheduleId}" not found`);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Check and send overdue emails
  // -------------------------------------------------------------------------

  /* eslint-disable no-await-in-loop, no-continue -- Sequential file processing required */
  async checkAndSend(): Promise<{
    sent: number;
    failed: number;
    errors: string[];
  }> {
    const result = { sent: 0, failed: 0, errors: [] as string[] };
    await this.ensureDirs();

    let files: string[];
    try {
      files = await fs.readdir(this.pendingDir);
    } catch {
      return result;
    }

    const jsonFiles = files.filter((f) => scheduleIdFromFilename(f));
    const now = Date.now();

    // Process files sequentially — must not double-send
    // eslint-disable-next-line no-restricted-syntax
    for (const file of jsonFiles) {
      const id = scheduleIdFromFilename(file);
      if (!id) continue;
      const filePath = queueFile(this.pendingDir, id);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const scheduled = JSON.parse(content) as ScheduledEmail;
        if (scheduled.id !== id) continue;

        // Reset stale locks
        if (scheduled.status === 'sending' && scheduled.lastError !== undefined) {
          const lockAge = now - new Date(scheduled.createdAt).getTime();
          if (lockAge > STALE_LOCK_MS) {
            scheduled.status = 'pending';
          }
        } else if (scheduled.status === 'sending') {
          // Check if it's been sending too long (use sendAt as reference)
          continue;
        }

        // Skip non-pending
        if (scheduled.status !== 'pending') continue;

        // Skip if not yet due
        if (new Date(scheduled.sendAt).getTime() > now) continue;

        // Skip if max attempts exceeded
        if (scheduled.attempts >= MAX_ATTEMPTS) {
          scheduled.status = 'failed';
          scheduled.lastError = 'Max retry attempts exceeded';
          await this.writeScheduledFile(scheduled);
          result.failed += 1;
          continue;
        }

        // Acquire lock
        scheduled.status = 'sending';
        scheduled.attempts += 1;
        await this.writeScheduledFile(scheduled);

        // Send
        const sendResult = await this.smtpService.sendEmail(scheduled.account, {
          to: scheduled.to,
          subject: scheduled.subject,
          body: scheduled.body,
          cc: scheduled.cc,
          bcc: scheduled.bcc,
          html: scheduled.html,
        });

        // Mark as sent and move to sent dir
        scheduled.status = 'sent';
        scheduled.sentAt = new Date().toISOString();
        scheduled.sentMessageId = sendResult.messageId;

        const sentPath = queueFile(this.sentDir, id);
        await fs.writeFile(sentPath, JSON.stringify(scheduled, null, 2));
        await fs.unlink(filePath);

        // Delete draft (best-effort)
        if (scheduled.draftMessageId && scheduled.draftMailbox) {
          try {
            await this.imapService.deleteEmail(
              scheduled.account,
              scheduled.draftMessageId,
              scheduled.draftMailbox,
            );
          } catch {
            // Best-effort
          }
        }

        result.sent += 1;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${file}: ${errorMsg}`);

        // Mark as failed in the file
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const scheduled = JSON.parse(content) as ScheduledEmail;
          scheduled.status = scheduled.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
          scheduled.lastError = errorMsg;
          await fs.writeFile(filePath, JSON.stringify(scheduled, null, 2));
        } catch {
          // If we can't even update the file, skip
        }

        result.failed += 1;
      }
    }

    return result;
  }
  /* eslint-enable no-await-in-loop, no-continue */

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.pendingDir, { recursive: true });
    await fs.mkdir(this.sentDir, { recursive: true });
  }

  private async writeScheduledFile(scheduled: ScheduledEmail): Promise<void> {
    await this.ensureDirs();
    const filePath = queueFile(this.pendingDir, scheduled.id);
    await fs.writeFile(filePath, JSON.stringify(scheduled, null, 2));
  }

  private static async readDir(dirPath: string): Promise<ScheduledEmail[]> {
    const emails: ScheduledEmail[] = [];
    try {
      const files = await fs.readdir(dirPath);
      // eslint-disable-next-line no-restricted-syntax
      for (const file of files) {
        const id = scheduleIdFromFilename(file);
        if (!id) continue; // eslint-disable-line no-continue
        try {
          const content = await fs.readFile(queueFile(dirPath, id), 'utf-8'); // eslint-disable-line no-await-in-loop
          const scheduled = JSON.parse(content) as ScheduledEmail;
          if (scheduled.id !== id) continue; // eslint-disable-line no-continue
          emails.push(scheduled);
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Directory may not exist yet
    }
    return emails;
  }
}
