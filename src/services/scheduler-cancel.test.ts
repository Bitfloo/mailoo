import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import queueId from '../test-support/queue-id.js';
import {
  createService,
  fillQueue,
  SCHEDULE_CLAIM_SUFFIX,
} from '../test-support/scheduler-fixtures.js';

describe('cancel error messages', () => {
  // cancel_scheduled returns these strings. Nothing else checks the full
  // wording, so a typo would stay green.

  it('rejects cancelling an email whose status is sending', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-cancel-'));
    try {
      await fillQueue(queueDir, 1, 'sending');
      const { service } = createService(queueDir);
      await expect(service.cancel(queueId(0))).rejects.toThrow(
        /^Cannot cancel email that is already being sent$/,
      );
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('rejects cancelling an email whose status is failed', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-cancel-'));
    try {
      await fillQueue(queueDir, 1, 'failed');
      const { service } = createService(queueDir);
      await expect(service.cancel(queueId(0))).rejects.toThrow(
        /^Cannot cancel email with status "failed"$/,
      );
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('rejects cancelling an unknown schedule id', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-cancel-'));
    const id = queueId(1);
    try {
      const { service } = createService(queueDir);
      await expect(service.cancel(id)).rejects.toThrow(
        new RegExp(`^Scheduled email "${id}" not found$`),
      );
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('rejects cancelling a pending email while a fresh claim is held', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-cancel-'));
    const id = queueId(0);
    const filePath = path.join(queueDir, `${id}.json`);
    const lockPath = path.join(queueDir, `${id}${SCHEDULE_CLAIM_SUFFIX}`);
    try {
      await fillQueue(queueDir, 1, 'pending');
      const before = await fs.readFile(filePath, 'utf8');
      await fs.writeFile(lockPath, 'held', { flag: 'wx' });
      // A claim older than the stale window can be taken, so this holder's
      // mtime stays inside that window. Cancel must refuse and leave both files.
      const fresh = new Date();
      await fs.utimes(lockPath, fresh, fresh);
      const { service } = createService(queueDir);
      await expect(service.cancel(id)).rejects.toThrow(
        /^Cannot cancel email that is already being sent$/,
      );
      expect(await fs.readFile(lockPath, 'utf8')).toBe('held');
      expect(await fs.readFile(filePath, 'utf8')).toBe(before);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});
