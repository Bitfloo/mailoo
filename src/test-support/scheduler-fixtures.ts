/**
 * One throwaway state home per scheduler test file. XDG paths are fixed at the first import of
 * config/xdg.js, so the scheduler service is imported here only after XDG_STATE_HOME points at
 * it; test files take the service and its constants from this module.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Mock } from 'vitest';

import type { ScheduledEmail } from '../types/index.js';
import queueId from './queue-id.js';

export const stateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-'));
vi.stubEnv('XDG_STATE_HOME', stateHome);

/** The queue a service built without a queue directory uses. */
export const { SCHEDULED_DIR: scheduledDir } = await import('../config/xdg.js');
// Fails every file that imports this module, before any test can write a queue file under HOME.
const queueFromHome = path.relative(stateHome, scheduledDir);
if (queueFromHome.startsWith('..') || path.isAbsolute(queueFromHome)) {
  throw new Error(`Scheduler test queue ${scheduledDir} is outside the test state home`);
}

export const {
  default: SchedulerService,
  CLAIM_RENEW_MS,
  MAX_ATTEMPTS,
  MAX_PENDING_SCHEDULES,
  SCHEDULE_CLAIM_SUFFIX,
  STALE_LOCK_MS,
} = await import('../services/scheduler.service.js');

export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

interface ServiceUnderTest {
  service: InstanceType<typeof SchedulerService>;
  imap: { saveDraft: Mock; deleteEmail: Mock };
  smtp: { sendEmail: Mock; messageIdFor: (account: string, token: string) => string };
}

export function createService(queueDir?: string): ServiceUnderTest {
  const imap = {
    saveDraft: vi.fn().mockRejectedValue(new Error('draft unavailable')),
    deleteEmail: vi.fn().mockResolvedValue(undefined),
  };
  const smtp = {
    sendEmail: vi.fn().mockResolvedValue({ messageId: '<scheduled@example.com>' }),
    messageIdFor: (_account: string, token: string) => `<${token}@example.com>`,
  };
  const service = new SchedulerService(smtp as never, imap as never, queueDir);
  return { service, imap, smtp };
}

export async function jsonNames(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

export function pendingRecord(id: string, sendAt: string): ScheduledEmail {
  return {
    id,
    account: 'personal',
    to: ['user@example.com'],
    subject: 'Hello',
    body: 'Body',
    html: false,
    sendAt,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    attempts: 0,
  };
}

export async function fillQueue(
  queueDir: string,
  count: number,
  status: ScheduledEmail['status'],
): Promise<void> {
  await Promise.all(
    Array.from({ length: count }, async (_unused, index) => {
      const id = queueId(index);
      await fs.writeFile(
        path.join(queueDir, `${id}.json`),
        JSON.stringify({ ...pendingRecord(id, daysFromNow(2)), status }),
      );
    }),
  );
}

export async function writeDue(
  queueDir: string,
  id: string,
  status: ScheduledEmail['status'],
): Promise<void> {
  const record = {
    ...pendingRecord(id, '2020-01-01T00:00:00.000Z'),
    status,
  };
  await fs.writeFile(path.join(queueDir, `${id}.json`), JSON.stringify(record));
}

export async function withDueQueue(
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

/**
 * Holds the first read of filePath until resume() runs, so that reader goes
 * on with bytes another check has made stale in the meantime.
 */
export async function withHeldFirstRead(
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

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(stateHome, { recursive: true, force: true });
});
