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

/** Max age (ms) of a queue claim before another check may send that email. */
export const STALE_LOCK_MS = 5 * 60 * 1000;

// Renew well inside the stale window so only a dead holder's claim goes stale.
const CLAIM_RENEW_MS = STALE_LOCK_MS / 5;

/** Beside `<id>.json`. Exclusive create (`wx`) is the only claim. */
export const SCHEDULE_CLAIM_SUFFIX = '.lock';

/** Max retry attempts before marking as "failed" */
const MAX_ATTEMPTS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Local queue horizon. Longer delays belong in the mailbox, not on disk. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * MS_PER_DAY;

/** Chosen cap, not a protocol limit. */
export const MAX_SCHEDULE_RECIPIENTS = 50;

/**
 * Chosen cap for Subject, In-Reply-To, and References, aligned with the
 * RFC 5322 §2.1.1 limit of 998 characters on a line. A folded header may be longer.
 */
export const MAX_HEADER_LINE_CHARS = 998;

/** Chosen cap. The body is stored in the queue file, so one message cannot fill the disk. */
export const MAX_SCHEDULE_BODY_CHARS = 5_000_000;

/** Chosen cap. Each schedule call and each tick reads every live queue file. */
export const MAX_PENDING_SCHEDULES = 100;

/** crypto.randomUUID() values. Anything else is not a safe filename. */
const SCHEDULE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Seconds may be omitted. An offset is required because the server's local zone is ambiguous. */
export const SEND_AT_FORMAT = 'ISO 8601 date-time with UTC offset, e.g. 2026-10-01T09:00:00+02:00';

const SEND_AT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

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
  return path.resolve(dir, `${id}.json`);
}

function lockFile(dir: string, id: string): string {
  if (!SCHEDULE_ID_RE.test(id)) {
    throw new Error('Schedule id is not valid');
  }
  return path.resolve(dir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

async function createClaim(lockPath: string, token: string): Promise<boolean> {
  try {
    await fs.writeFile(lockPath, token, { flag: 'wx' });
    return true;
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false;
    throw err;
  }
}

async function claimAge(lockPath: string, now: number): Promise<number | undefined> {
  try {
    const stat = await fs.stat(lockPath);
    return now - stat.mtimeMs;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

async function stealStaleClaim(
  dir: string,
  id: string,
  lockPath: string,
  now: number,
  token: string,
): Promise<boolean> {
  const parked = path.resolve(dir, `${id}${SCHEDULE_CLAIM_SUFFIX}.${crypto.randomUUID()}`);
  try {
    await fs.rename(lockPath, parked);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
  try {
    const age = await claimAge(parked, now);
    if (age === undefined || age <= STALE_LOCK_MS) {
      try {
        // rename would replace a claim created after the park.
        await fs.link(parked, lockPath);
      } catch (err) {
        if (errnoCode(err) !== 'EEXIST') throw err;
      }
      return false;
    }
    return await createClaim(lockPath, token);
  } finally {
    await fs.unlink(parked).catch(() => undefined);
  }
}

/**
 * Exclusive right to send or cancel this id.
 * The in-process timer and `mailoo scheduler` can both read a pending file;
 * only the caller that creates the claim continues. While a claimed email is
 * being sent, that holder refreshes the claim's mtime every CLAIM_RENEW_MS.
 * A claim older than STALE_LOCK_MS has not been refreshed within that window
 * and may be taken again. Release deletes the lock when its content is this
 * holder's token, and leaves the lock in place when the content is not.
 */
async function claimSchedule(
  dir: string,
  id: string,
  now = Date.now(),
): Promise<string | undefined> {
  const lockPath = lockFile(dir, id);
  const token = crypto.randomUUID();
  if (await createClaim(lockPath, token)) return token;
  const age = await claimAge(lockPath, now);
  if (age === undefined) {
    return (await createClaim(lockPath, token)) ? token : undefined;
  }
  if (age <= STALE_LOCK_MS) return undefined;
  return (await stealStaleClaim(dir, id, lockPath, now, token)) ? token : undefined;
}

function startClaimRenewal(lockPath: string): () => void {
  const timer = setInterval(() => {
    fs.utimes(lockPath, new Date(), new Date()).catch(() => undefined);
  }, CLAIM_RENEW_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

async function releaseClaim(dir: string, id: string, token: string): Promise<void> {
  const lockPath = lockFile(dir, id);
  try {
    const current = await fs.readFile(lockPath, 'utf8');
    if (current !== token) return;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return;
    throw err;
  }
  try {
    await fs.unlink(lockPath);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
  }
}

async function readScheduled(filePath: string): Promise<ScheduledEmail | undefined> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as ScheduledEmail;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

function isDue(scheduled: ScheduledEmail, id: string, now: number): boolean {
  return (
    scheduled.id === id &&
    scheduled.status !== 'failed' &&
    scheduled.status !== 'sent' &&
    new Date(scheduled.sendAt).getTime() <= now
  );
}

function assertCancellable(scheduled: ScheduledEmail): void {
  if (scheduled.status === 'sending') {
    throw new Error('Cannot cancel email that is already being sent');
  }
  if (scheduled.status !== 'pending') {
    throw new Error(`Cannot cancel email with status "${scheduled.status}"`);
  }
}

/** Chosen bound. An account name is a local label stored in the queue file, not a protocol field. */
const MAX_ACCOUNT_NAME_CHARS = 128;

function assertAccount(account: string): void {
  /* eslint-disable no-control-regex */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in account names
  const control = /[\u0000-\u001F\u007F]/;
  /* eslint-enable no-control-regex */
  if (
    account.trim().length === 0 ||
    account.length > MAX_ACCOUNT_NAME_CHARS ||
    control.test(account)
  ) {
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

/**
 * Failed files stay in this directory and cancel accepts only pending,
 * so they must not consume the cap. The claim file is not a second entry:
 * the queue json stays, with status pending or sending, until send or cancel.
 */
async function countLiveSchedules(dir: string): Promise<number> {
  const names = await fs.readdir(dir);
  const statuses = await Promise.all(
    names.map(async (name) => {
      const id = scheduleIdFromFilename(name);
      if (!id) return undefined;
      try {
        const content = await fs.readFile(queueFile(dir, id), 'utf-8');
        const scheduled = JSON.parse(content) as ScheduledEmail;
        return scheduled.status;
      } catch {
        return undefined;
      }
    }),
  );
  return statuses.filter((status) => status === 'pending' || status === 'sending').length;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

function sendAtFieldsInvalid(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  return month > 12 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59;
}

function parseSendAt(sendAt: string, now = Date.now()): Date {
  const match = sendAt.length <= 40 ? SEND_AT_RE.exec(sendAt) : null;
  if (!match) {
    throw new Error(`Invalid send_at date: ${sendAt}. Expected ${SEND_AT_FORMAT}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  // Date rolls 30 February and hour 24 forward. Check the fields before that.
  if (sendAtFieldsInvalid(year, month, day, hour, minute, second)) {
    throw new Error(`Invalid send_at date: ${sendAt}. Expected ${SEND_AT_FORMAT}`);
  }
  const date = new Date(sendAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid send_at date: ${sendAt}. Expected ${SEND_AT_FORMAT}`);
  }
  if (date.getTime() <= now) {
    throw new Error('send_at must be in the future');
  }
  if (date.getTime() - now > MAX_SCHEDULE_AHEAD_MS) {
    throw new Error(`send_at must be within ${MAX_SCHEDULE_AHEAD_MS / MS_PER_DAY} days`);
  }
  return date;
}

export default class SchedulerService {
  private readonly pendingDir: string;

  private readonly sentDir: string;

  // Parallel calls would each count before any of them writes.
  private scheduleChain: Promise<void> = Promise.resolve();

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
    assertHeaderField(options.subject, 'Subject', MAX_HEADER_LINE_CHARS);
    validateInputLength(options.body, MAX_SCHEDULE_BODY_CHARS, 'Body');
    if (options.inReplyTo !== undefined) {
      assertHeaderField(options.inReplyTo, 'In-Reply-To', MAX_HEADER_LINE_CHARS);
    }
    options.references?.forEach((reference) => {
      assertHeaderField(reference, 'References', MAX_HEADER_LINE_CHARS);
    });
    const sendAtDate = parseSendAt(options.sendAt);

    await this.ensureDirs();
    return this.enqueueSchedule(async () => {
      const pendingCount = await countLiveSchedules(this.pendingDir);
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
    });
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
    let claimToken: string | undefined;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const scheduled = JSON.parse(content) as ScheduledEmail;
      assertCancellable(scheduled);

      claimToken = await claimSchedule(this.pendingDir, scheduleId);
      if (!claimToken) {
        throw new Error('Cannot cancel email that is already being sent');
      }

      const current = await readScheduled(filePath);
      if (!current) {
        throw new Error(`Scheduled email "${scheduleId}" not found`);
      }
      assertCancellable(current);

      if (current.draftMessageId && current.draftMailbox) {
        try {
          await this.imapService.deleteEmail(
            current.account,
            current.draftMessageId,
            current.draftMailbox,
          );
          draftDeleted = true;
        } catch {
          // Draft deletion is best-effort
        }
      }

      await fs.unlink(filePath);
      return { cancelled: true, draftDeleted };
    } catch (err) {
      if (errnoCode(err) === 'ENOENT') {
        throw new Error(`Scheduled email "${scheduleId}" not found`);
      }
      throw err;
    } finally {
      if (claimToken) await releaseClaim(this.pendingDir, scheduleId, claimToken);
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

    // eslint-disable-next-line no-restricted-syntax
    for (const file of jsonFiles) {
      const delivery = await this.processQueueFile(file, now);
      if (delivery.outcome === 'skipped') continue;
      if (delivery.outcome === 'sent') result.sent += 1;
      else if (delivery.outcome === 'failed') {
        result.failed += 1;
        if (delivery.error !== undefined) result.errors.push(`${file}: ${delivery.error}`);
      }
    }

    return result;
  }
  /* eslint-enable no-await-in-loop, no-continue */

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async enqueueSchedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.scheduleChain.then(task);
    this.scheduleChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureDirs(): Promise<void> {
    await fs.mkdir(this.pendingDir, { recursive: true });
    await fs.mkdir(this.sentDir, { recursive: true });
  }

  private async writeScheduledFile(scheduled: ScheduledEmail): Promise<void> {
    await this.ensureDirs();
    const filePath = queueFile(this.pendingDir, scheduled.id);
    await fs.writeFile(filePath, JSON.stringify(scheduled, null, 2));
  }

  private async processQueueFile(
    file: string,
    now: number,
  ): Promise<{ outcome: 'sent' | 'failed' | 'skipped'; error?: string }> {
    const id = scheduleIdFromFilename(file);
    if (!id) return { outcome: 'skipped' };
    const filePath = queueFile(this.pendingDir, id);
    let claimToken: string | undefined;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const scheduled = JSON.parse(content) as ScheduledEmail;
      if (!isDue(scheduled, id, now)) return { outcome: 'skipped' };

      claimToken = await claimSchedule(this.pendingDir, id, now);
      if (!claimToken) return { outcome: 'skipped' };

      const fresh = await readScheduled(filePath);
      if (!fresh || !isDue(fresh, id, now)) return { outcome: 'skipped' };
      if (fresh.attempts >= MAX_ATTEMPTS) {
        fresh.status = 'failed';
        fresh.lastError = 'Max retry attempts exceeded';
        await this.writeScheduledFile(fresh);
        return { outcome: 'failed' };
      }

      await this.sendClaimedEmail(fresh, id);
      return { outcome: 'sent' };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.writeSendFailure(id, errorMsg);
      return { outcome: 'failed', error: errorMsg };
    } finally {
      if (claimToken) await releaseClaim(this.pendingDir, id, claimToken);
    }
  }

  private async sendClaimedEmail(queued: ScheduledEmail, id: string): Promise<void> {
    const filePath = queueFile(this.pendingDir, id);
    const sending: ScheduledEmail = {
      ...queued,
      status: 'sending',
      attempts: queued.attempts + 1,
    };
    await this.writeScheduledFile(sending);

    const stopRenewal = startClaimRenewal(lockFile(this.pendingDir, id));
    try {
      const sendResult = await this.smtpService.sendEmail(sending.account, {
        to: sending.to,
        subject: sending.subject,
        body: sending.body,
        cc: sending.cc,
        bcc: sending.bcc,
        html: sending.html,
      });

      const sent: ScheduledEmail = {
        ...sending,
        status: 'sent',
        sentAt: new Date().toISOString(),
        sentMessageId: sendResult.messageId,
      };
      await fs.writeFile(queueFile(this.sentDir, id), JSON.stringify(sent, null, 2));
      await fs.unlink(filePath);

      if (sent.draftMessageId && sent.draftMailbox) {
        try {
          await this.imapService.deleteEmail(sent.account, sent.draftMessageId, sent.draftMailbox);
        } catch {
          // Best-effort
        }
      }
    } finally {
      stopRenewal();
    }
  }

  private async writeSendFailure(id: string, errorMsg: string): Promise<void> {
    const filePath = queueFile(this.pendingDir, id);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const scheduled = JSON.parse(content) as ScheduledEmail;
      scheduled.status = scheduled.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      scheduled.lastError = errorMsg;
      await fs.writeFile(filePath, JSON.stringify(scheduled, null, 2));
    } catch {
      // If we can't even update the file, skip
    }
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
