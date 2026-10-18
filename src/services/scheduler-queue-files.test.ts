import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import queueId from '../test-support/queue-id.js';
import type { SchedulerService } from '../test-support/scheduler-fixtures.js';
import {
  createService,
  daysFromNow,
  fillQueue,
  jsonNames,
  pendingRecord,
  scheduledDir,
  stateHome,
} from '../test-support/scheduler-fixtures.js';
import type { ScheduledEmail } from '../types/index.js';

async function liveFileCount(dir: string): Promise<number> {
  const names = await jsonNames(dir);
  const statuses = await Promise.all(
    names.map(async (name) => {
      const content = await fs.readFile(path.join(dir, name), 'utf8');
      const scheduled = JSON.parse(content) as ScheduledEmail;
      return scheduled.status;
    }),
  );
  return statuses.filter((status) => status === 'pending' || status === 'sending').length;
}

async function scheduleHello(service: InstanceType<typeof SchedulerService>) {
  return service.schedule('personal', {
    to: ['user@example.com'],
    subject: 'Hello',
    body: 'Body',
    sendAt: daysFromNow(2),
  });
}

describe('SchedulerService queue files', () => {
  it('does not delete a file outside the queue when the schedule id leaves the directory', async () => {
    const canaryDir = path.join(stateHome, 'mailoo', 'canary');
    await fs.mkdir(canaryDir, { recursive: true });
    const canary = path.join(canaryDir, 'secret.json');
    await fs.writeFile(canary, `${JSON.stringify(pendingRecord('x', daysFromNow(1)))}\n`);
    const { service } = createService();

    await expect(service.cancel('../canary/secret')).rejects.toThrow(/id/);
    expect(await fs.readFile(canary, 'utf8')).toContain('"status":"pending"');
  });

  it('does not write outside the queue when a stored id leaves the directory', async () => {
    const outside = path.join(stateHome, 'mailoo', 'escaped.json');
    await fs.mkdir(scheduledDir, { recursive: true });
    const filename = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json';
    await fs.writeFile(
      path.join(scheduledDir, filename),
      JSON.stringify(pendingRecord('../escaped', daysFromNow(-1))),
    );
    const { service } = createService();

    await service.checkAndSend();
    await expect(fs.access(outside)).rejects.toThrow();
  });

  it('stores a valid schedule inside the queue directory', async () => {
    const { service } = createService();
    const scheduled = await service.schedule('personal', {
      to: ['user@example.com'],
      subject: 'Hello',
      body: 'Body',
      sendAt: daysFromNow(2),
    });
    const filePath = path.join(scheduledDir, `${scheduled.id}.json`);
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8')) as ScheduledEmail;
    expect(saved.id).toBe(scheduled.id);
    expect(saved.to).toEqual(['user@example.com']);
    expect(path.relative(scheduledDir, filePath).startsWith('..')).toBe(false);
  });

  it('should store the cc and bcc recipients in the queue record', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-copies-'));
    try {
      const { service } = createService(queueDir);
      const scheduled = await service.schedule('personal', {
        to: ['user@example.com'],
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
      });
      const filePath = path.join(queueDir, `${scheduled.id}.json`);
      const saved = JSON.parse(await fs.readFile(filePath, 'utf8')) as ScheduledEmail;
      expect({ cc: saved.cc, bcc: saved.bcc }).toEqual({
        cc: ['cc@example.com'],
        bcc: ['bcc@example.com'],
      });
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('rejects a schedule when the queue already holds 100 messages', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-pending-'));
    try {
      await fillQueue(queueDir, 100, 'pending');
      const { service } = createService(queueDir);
      await expect(
        service.schedule('personal', {
          to: ['user@example.com'],
          subject: 'Hello',
          body: 'Body',
          sendAt: daysFromNow(2),
        }),
      ).rejects.toThrow(/100/);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('schedules an email when the queue holds 100 failed messages and no pending ones', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-failed-'));
    try {
      await fillQueue(queueDir, 100, 'failed');
      const { service } = createService(queueDir);
      const scheduled = await service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
      });
      expect(scheduled.status).toBe('pending');
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('rejects a schedule when 100 messages are still being sent', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-sending-'));
    try {
      await fillQueue(queueDir, 100, 'sending');
      const { service } = createService(queueDir);
      await expect(
        service.schedule('personal', {
          to: ['user@example.com'],
          subject: 'Hello',
          body: 'Body',
          sendAt: daysFromNow(2),
        }),
      ).rejects.toThrow(/Too many scheduled emails/);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('admits one schedule when ten calls race at 99 live files', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-pending-'));
    try {
      await fillQueue(queueDir, 99, 'pending');
      const { service } = createService(queueDir);
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, async () => scheduleHello(service)),
      );
      const messages = results.flatMap((result) => {
        if (result.status !== 'rejected') return [];
        const { reason } = result;
        return [reason instanceof Error ? reason.message : String(reason)];
      });
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(messages).toEqual(
        Array.from({ length: 9 }, () => expect.stringMatching(/Too many scheduled emails/)),
      );
      expect(await liveFileCount(queueDir)).toBe(100);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('schedules an email after a raced batch once one schedule is cancelled', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-pending-'));
    try {
      await fillQueue(queueDir, 99, 'pending');
      const { service } = createService(queueDir);
      await Promise.allSettled(Array.from({ length: 10 }, async () => scheduleHello(service)));
      await service.cancel(queueId(0));
      const scheduled = await scheduleHello(service);
      expect(scheduled.status).toBe('pending');
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});
