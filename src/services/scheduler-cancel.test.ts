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

describe('cancel under the claim', () => {
  let queueDir: string;
  const id = queueId(0);

  beforeEach(async () => {
    queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-cancel-claim-'));
    await fillQueue(queueDir, 1, 'pending');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(queueDir, { recursive: true, force: true });
  });

  /** Another check fails the email after cancel's first read and before its claim. */
  async function failAfterFirstRead(): Promise<string> {
    const filePath = path.join(queueDir, `${id}.json`);
    const record = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
    const failed = JSON.stringify({ ...record, status: 'failed', attempts: 3 });
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async (file, options) => {
      const content = await readFile(file, options as { encoding: 'utf8' });
      await fs.writeFile(filePath, failed);
      return content;
    });
    return failed;
  }

  async function lockNames(): Promise<string[]> {
    const names = await fs.readdir(queueDir);
    return names.filter((name) => name.endsWith(SCHEDULE_CLAIM_SUFFIX));
  }

  it('should refuse to cancel a record that became failed after cancel first read it', async () => {
    const failed = await failAfterFirstRead();
    const { service } = createService(queueDir);
    const outcome = await service.cancel(id).then(
      () => 'cancelled',
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    expect({
      outcome,
      record: await fs.readFile(path.join(queueDir, `${id}.json`), 'utf8').catch(() => 'deleted'),
    }).toEqual({ outcome: 'Cannot cancel email with status "failed"', record: failed });
  });

  // A lock left behind is never checked again once its record is gone.
  it('should leave no lock file behind after a cancel', async () => {
    const { service } = createService(queueDir);
    await service.cancel(id);
    expect(await lockNames()).toEqual([]);
  });

  it('should leave no lock file behind after a cancel that fails under the claim', async () => {
    await failAfterFirstRead();
    const { service } = createService(queueDir);
    await service.cancel(id).catch(() => undefined);
    expect(await lockNames()).toEqual([]);
  });
});
