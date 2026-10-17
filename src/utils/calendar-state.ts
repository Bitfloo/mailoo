/**
 * One-shot calendar processing state.
 *
 * Tracks which emails have already been auto-processed for calendar/reminder
 * creation via the hook system. Once an email is marked as processed, the
 * auto-trigger is suppressed — the user must explicitly instruct the AI to
 * create further events or reminders for that email.
 *
 * Manual tool calls (add_to_calendar, create_reminder) always work regardless
 * of this state — it only gates the automatic hook trigger.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { CALENDAR_STATE_FILE } from '../config/xdg.js';
import writeFileAtomic from './atomic-write.js';
import { acquireClaim, errnoCode, releaseClaim, startClaimRenewal } from './file-claim.js';

const LOCK_FILE = `${CALENDAR_STATE_FILE}.lock`;

/** A holder reads and rewrites one small file, so a lock this old has no live holder. */
export const CALENDAR_LOCK_STALE_MS = 10_000;

const LOCK_RETRY_MS = 50;
const LOCK_RETRIES = 20;

export type CalendarAction = 'event' | 'reminder' | 'both' | 'skipped';

export interface ProcessedEntry {
  processedAt: string;
  action: CalendarAction;
  title?: string;
}

interface StateFile {
  processedEmails: Record<string, ProcessedEntry>;
}

function stateKey(accountName: string, emailId: string): string {
  return `${accountName.replace(/\s+/g, '_')}__${emailId}`;
}

async function readState(): Promise<StateFile> {
  let raw: string;
  try {
    raw = await fs.readFile(CALENDAR_STATE_FILE, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { processedEmails: {} };
    throw err;
  }
  try {
    return JSON.parse(raw) as StateFile;
  } catch {
    // Reading it as empty would let the hooks add every calendar event again.
    throw new Error(
      `${path.basename(CALENDAR_STATE_FILE)} in the Mailoo state directory is not valid JSON. ` +
        'Fix or remove it to resume automatic calendar processing.',
    );
  }
}

async function writeState(state: StateFile): Promise<void> {
  await fs.mkdir(path.dirname(CALENDAR_STATE_FILE), { recursive: true });
  await writeFileAtomic(CALENDAR_STATE_FILE, JSON.stringify(state, null, 2));
}

async function acquireStateLock(retries: number): Promise<string> {
  const token = await acquireClaim(LOCK_FILE, CALENDAR_LOCK_STALE_MS);
  if (token !== undefined) return token;
  if (retries <= 0) {
    throw new Error('Calendar state is busy in another Mailoo process. Try again shortly.');
  }
  await new Promise((resolve) => {
    setTimeout(resolve, LOCK_RETRY_MS);
  });
  return acquireStateLock(retries - 1);
}

/** Run fn while holding the state lock, so two processes cannot drop each other's entries. */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(LOCK_FILE), { recursive: true });
  const token = await acquireStateLock(LOCK_RETRIES);
  const stopRenewal = startClaimRenewal(LOCK_FILE, CALENDAR_LOCK_STALE_MS / 5);
  try {
    return await fn();
  } finally {
    stopRenewal();
    await releaseClaim(LOCK_FILE, token);
  }
}

/** Returns true if this email has already been auto-processed by the hook system. */
export async function isCalendarProcessed(accountName: string, emailId: string): Promise<boolean> {
  const state = await readState();
  return stateKey(accountName, emailId) in state.processedEmails;
}

/** Marks an email as processed so the hook auto-trigger won't fire again. */
export async function markCalendarProcessed(
  accountName: string,
  emailId: string,
  action: CalendarAction,
  title?: string,
): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    state.processedEmails[stateKey(accountName, emailId)] = {
      processedAt: new Date().toISOString(),
      action,
      title,
    };
    await writeState(state);
  });
}

/** Returns all processed entries (for inspection/debugging). */
export async function listCalendarProcessed(): Promise<{ key: string; entry: ProcessedEntry }[]> {
  const state = await readState();
  return Object.entries(state.processedEmails).map(([key, entry]) => ({ key, entry }));
}
