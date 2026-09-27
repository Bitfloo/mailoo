import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildTestAccount,
  createTestServices,
  TEST_ACCOUNT_NAME,
  type TestServices,
} from './helpers/index.js';

describe('scheduled mail on GreenMail', () => {
  let services: TestServices;
  let stateHome: string;

  beforeAll(async () => {
    stateHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-sched-it-'));
    vi.stubEnv('XDG_STATE_HOME', stateHome);
    services = createTestServices(buildTestAccount());
    try {
      await services.imapService.createMailbox(TEST_ACCOUNT_NAME, 'Drafts');
    } catch {
      // GreenMail keeps the mailbox after the first test run in this container.
    }
  });

  afterAll(async () => {
    await services.connections.closeAll();
    vi.unstubAllEnvs();
    await fs.rm(stateHome, { recursive: true, force: true });
  });

  it('keeps the draft when the schedule id is not a queue file name', async () => {
    vi.resetModules();
    const xdg = await import('../config/xdg.js');
    expect(xdg.SCHEDULED_DIR.startsWith(stateHome)).toBe(true);
    const { default: SchedulerService } = await import('../services/scheduler.service.js');
    const scheduler = new SchedulerService(services.smtpService, services.imapService);
    const marker = `queue-${Date.now()}`;
    const scheduled = await scheduler.schedule(TEST_ACCOUNT_NAME, {
      to: ['bob@localhost'],
      subject: marker,
      body: 'See you then.',
      sendAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
    });

    expect(scheduled.draftMessageId).toBeTruthy();
    expect(scheduled.draftMailbox).toBeTruthy();
    const draftId = scheduled.draftMessageId ?? '';
    const draftMailbox = scheduled.draftMailbox ?? '';
    const before = await services.imapService.getEmail(TEST_ACCOUNT_NAME, draftId, draftMailbox);
    expect(before.subject).toContain(marker);

    await expect(scheduler.cancel('../canary/secret')).rejects.toThrow(/id/);
    const still = await services.imapService.getEmail(TEST_ACCOUNT_NAME, draftId, draftMailbox);
    expect(still.subject).toContain(marker);

    const result = await scheduler.cancel(scheduled.id);
    expect(result.cancelled).toBe(true);
    await expect(
      services.imapService.getEmail(TEST_ACCOUNT_NAME, draftId, draftMailbox),
    ).rejects.toThrow();
    await expect(
      fs.readFile(path.join(xdg.SCHEDULED_DIR, `${scheduled.id}.json`), 'utf8'),
    ).rejects.toThrow();
  });
});
