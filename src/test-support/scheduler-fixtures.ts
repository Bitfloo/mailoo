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

export const {
  default: SchedulerService,
  MAX_ATTEMPTS,
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

afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(stateHome, { recursive: true, force: true });
});
