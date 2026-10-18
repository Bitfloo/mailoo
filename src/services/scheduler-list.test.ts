import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import ConnectionManager from '../connections/manager.js';
import queueId from '../test-support/queue-id.js';
import {
  createService,
  daysFromNow,
  pendingRecord,
  SchedulerService,
} from '../test-support/scheduler-fixtures.js';
import { testAccount } from '../test-support/watcher-harness.js';
import type { ScheduledEmail } from '../types/index.js';
import ImapService from './imap.service.js';

describe('list order', () => {
  it('should order a filtered list by send time', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-order-'));
    // Send times match neither the file-name order nor its reverse, so directory order cannot pass.
    const sendDays = [2, 3, 1];
    try {
      await Promise.all(
        sendDays.map(async (days, index) => {
          const id = queueId(index);
          await fs.writeFile(
            path.join(queueDir, `${id}.json`),
            JSON.stringify(pendingRecord(id, daysFromNow(days))),
          );
        }),
      );
      const { service } = createService(queueDir);
      const listed = await service.list({ status: 'pending' });
      expect(listed.map((email) => email.id)).toEqual([queueId(2), queueId(0), queueId(1)]);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });

  it('should order a list of every status by send time across the queue and sent/', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-order-all-'));
    try {
      // The queue directory is read before sent/, so an unsorted list puts the pending email first.
      await fs.writeFile(
        path.join(queueDir, `${queueId(0)}.json`),
        JSON.stringify(pendingRecord(queueId(0), daysFromNow(3))),
      );
      await fs.mkdir(path.join(queueDir, 'sent'));
      await fs.writeFile(
        path.join(queueDir, 'sent', `${queueId(1)}.json`),
        JSON.stringify({ ...pendingRecord(queueId(1), daysFromNow(1)), status: 'sent' }),
      );
      const { service } = createService(queueDir);
      const listed = await service.list({ status: 'all' });
      expect(listed.map((email) => email.id)).toEqual([queueId(1), queueId(0)]);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});

describe('list filters', () => {
  async function withQueue(
    records: ScheduledEmail[],
    body: (service: InstanceType<typeof SchedulerService>) => Promise<void>,
  ): Promise<void> {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-filter-'));
    try {
      await fs.mkdir(path.join(queueDir, 'sent'));
      await Promise.all(
        records.map(async (record) => {
          const dir = record.status === 'sent' ? path.join(queueDir, 'sent') : queueDir;
          await fs.writeFile(path.join(dir, `${record.id}.json`), JSON.stringify(record));
        }),
      );
      await body(createService(queueDir).service);
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  }

  function ids(emails: ScheduledEmail[]): string[] {
    return emails.map((email) => email.id);
  }

  it('should list only records of the requested status', async () => {
    const statuses: ScheduledEmail['status'][] = ['pending', 'sending', 'failed', 'sent'];
    const records = statuses.map((status, index) => ({
      ...pendingRecord(queueId(index), daysFromNow(index + 1)),
      status,
    }));
    await withQueue(records, async (service) => {
      expect({
        pending: ids(await service.list({ status: 'pending' })),
        failed: ids(await service.list({ status: 'failed' })),
      }).toEqual({ pending: [queueId(0)], failed: [queueId(2)] });
    });
  });

  it('should list only records of the requested account', async () => {
    const records = [
      pendingRecord(queueId(0), daysFromNow(1)),
      { ...pendingRecord(queueId(1), daysFromNow(2)), account: 'work' },
    ];
    await withQueue(records, async (service) => {
      expect(ids(await service.list({ account: 'work' }))).toEqual([queueId(1)]);
    });
  });

  // A record stores the resolved name, so the filter must resolve the way schedule_email did.
  it('should match the account filter by address and case, and keep a removed account listable', async () => {
    const queueDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-account-'));
    try {
      const records = [
        pendingRecord(queueId(0), daysFromNow(1)),
        { ...pendingRecord(queueId(1), daysFromNow(2)), account: 'work' },
        { ...pendingRecord(queueId(2), daysFromNow(3)), account: 'retired' },
      ];
      await Promise.all(
        records.map(async (record) =>
          fs.writeFile(path.join(queueDir, `${record.id}.json`), JSON.stringify(record)),
        ),
      );
      const connections = new ConnectionManager([
        { ...testAccount, name: 'personal', email: 'me@example.com' },
        { ...testAccount, name: 'work', email: 'work@example.com' },
      ]);
      const { smtp } = createService(queueDir);
      const service = new SchedulerService(smtp as never, new ImapService(connections), queueDir);

      expect({
        byAddress: ids(await service.list({ account: 'work@example.com' })),
        byCase: ids(await service.list({ account: 'WORK' })),
        removed: ids(await service.list({ account: 'retired' })),
      }).toEqual({ byAddress: [queueId(1)], byCase: [queueId(1)], removed: [queueId(2)] });
    } finally {
      await fs.rm(queueDir, { recursive: true, force: true });
    }
  });
});
