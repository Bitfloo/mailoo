import fs from 'node:fs/promises';

import queueId from '../test-support/queue-id.js';
import type SchedulerService from './scheduler.service.js';
import { SCHEDULER_INTERVAL_MS, startSchedulerLoop } from './scheduler.service.js';

describe('scheduler loop', () => {
  type CheckResult = Awaited<ReturnType<InstanceType<typeof SchedulerService>['checkAndSend']>>;

  const quiet: CheckResult = { sent: 0, failed: 0, deferred: 0, errors: [] };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function recorder() {
    const lines: [string, string][] = [];
    const log = (level: 'info' | 'warning', message: string) => {
      lines.push([level, message]);
    };
    return { lines, log };
  }

  it('should never run two checks at once when a check outlasts the interval', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const scheduler = {
      checkAndSend: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // A slow SMTP server: each check takes two and a half intervals.
        await new Promise((resolve) => {
          setTimeout(resolve, 2.5 * SCHEDULER_INTERVAL_MS);
        });
        inFlight -= 1;
        return quiet;
      },
    };
    const stop = startSchedulerLoop(scheduler, recorder().log);
    await vi.advanceTimersByTimeAsync(10 * SCHEDULER_INTERVAL_MS);
    stop();
    expect(maxInFlight).toBe(1);
  });

  it('should check again on the next interval after a check finishes', async () => {
    let checks = 0;
    const scheduler = {
      checkAndSend: async () => {
        checks += 1;
        return quiet;
      },
    };
    const stop = startSchedulerLoop(scheduler, recorder().log);
    await vi.advanceTimersByTimeAsync(3 * SCHEDULER_INTERVAL_MS);
    stop();
    expect(checks).toBe(4);
  });

  it('should log a check that throws at warning', async () => {
    const { lines, log } = recorder();
    const scheduler = {
      checkAndSend: async (): Promise<CheckResult> => {
        throw new Error('EACCES: permission denied, scandir');
      },
    };
    const stop = startSchedulerLoop(scheduler, log);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(lines).toEqual([
      ['warning', 'Scheduled send check failed: EACCES: permission denied, scandir'],
    ]);
  });

  it('should log failed sends with their errors at warning', async () => {
    const { lines, log } = recorder();
    const failed: CheckResult = {
      ...quiet,
      failed: 1,
      errors: [`${queueId(1)}.json: 550 mailbox unavailable`],
    };
    const stop = startSchedulerLoop({ checkAndSend: async () => failed }, log);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(lines).toEqual([
      ['warning', '1 scheduled email(s) failed'],
      ['warning', `Scheduled send error: ${queueId(1)}.json: 550 mailbox unavailable`],
    ]);
  });

  it('should log delivered emails at info', async () => {
    const { lines, log } = recorder();
    const stop = startSchedulerLoop({ checkAndSend: async () => ({ ...quiet, sent: 2 }) }, log);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(lines).toEqual([['info', 'Sent 2 scheduled email(s)']]);
  });

  it('should log emails the rate limit held back at info', async () => {
    const { lines, log } = recorder();
    const stop = startSchedulerLoop({ checkAndSend: async () => ({ ...quiet, deferred: 2 }) }, log);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(lines).toEqual([['info', '2 scheduled email(s) held back by the rate limit']]);
  });

  // Node 24 ends the process on an unhandled rejection, so a failing log sink would stop the server.
  it('should keep checking without an unhandled rejection when the log sink throws', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    let checks = 0;
    const scheduler = {
      checkAndSend: async () => {
        checks += 1;
        return { ...quiet, sent: 1 };
      },
    };
    const brokenLog = async () => {
      throw new Error('write EPIPE');
    };
    try {
      const stop = startSchedulerLoop(scheduler, brokenLog);
      await vi.advanceTimersByTimeAsync(SCHEDULER_INTERVAL_MS);
      stop();
      // Node reports unhandled rejections after the microtask queue drains.
      vi.useRealTimers();
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect({ checks, unhandled }).toEqual({ checks: 2, unhandled: [] });
  });

  it('should stop checking once stopped', async () => {
    let checks = 0;
    const scheduler = {
      checkAndSend: async () => {
        checks += 1;
        return quiet;
      },
    };
    const stop = startSchedulerLoop(scheduler, recorder().log);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(5 * SCHEDULER_INTERVAL_MS);
    expect(checks).toBe(1);
  });
});

describe('check interval in README.md', () => {
  it('should state the check interval wherever the scheduling section names an interval', async () => {
    const readme = await fs.readFile(new URL('../../README.md', import.meta.url), 'utf8');
    const section = readme.split('\n### ').find((part) => part.startsWith('Email Scheduling\n'));
    const unitMs = { second: 1000, minute: 60_000, hour: 3_600_000 };
    // Every interval the section names, so a new "every N minutes" line is checked too.
    const stated = [
      ...(section ?? '').matchAll(/\bevery (?:(\d+) )?(second|minute|hour)s?\b/g),
    ].map(([, count = '1', unit]) => Number(count) * unitMs[unit as keyof typeof unitMs]);
    expect([...new Set(stated)]).toEqual([SCHEDULER_INTERVAL_MS]);
  });
});
