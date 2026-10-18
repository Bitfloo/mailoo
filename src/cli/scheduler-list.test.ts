import { formatScheduledList } from '../test-support/scheduler-home.js';
import type { ScheduledEmail } from '../types/index.js';

function queued(
  status: ScheduledEmail['status'],
  fields: Partial<ScheduledEmail> = {},
): ScheduledEmail {
  return {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    account: 'personal',
    to: ['user@example.com'],
    subject: 'Hello',
    body: 'Body',
    html: false,
    sendAt: '2030-01-01T09:00:00.000Z',
    createdAt: '2029-12-31T09:00:00.000Z',
    status,
    attempts: 1,
    ...fields,
  };
}

describe('scheduler list command', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('should say no scheduled emails when the queue is empty', () => {
    expect(formatScheduledList([])).toEqual(['No scheduled emails.']);
  });

  it('should flag a pending email whose send time has passed as overdue and not one that is still in the future', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T10:00:00.000Z'));
    const later = queued('pending', {
      id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      sendAt: '2030-01-01T11:00:00.000Z',
    });
    expect(formatScheduledList([queued('pending'), later])).toEqual([
      '\n📬 Pending (2):',
      '  aaaaaaaa | personal → user@example.com | "Hello" | 2030-01-01T09:00:00.000Z ⚠️ OVERDUE',
      '  bbbbbbbb | personal → user@example.com | "Hello" | 2030-01-01T11:00:00.000Z',
    ]);
  });

  // The next check sends a pending email whose send time does not parse, so the list
  // must not show it as waiting for a later time.
  it('should flag a pending email whose send time does not parse as overdue', () => {
    expect(formatScheduledList([queued('pending', { sendAt: 'not-a-date' })])).toEqual([
      '\n📬 Pending (1):',
      '  aaaaaaaa | personal → user@example.com | "Hello" | not-a-date ⚠️ OVERDUE',
    ]);
  });

  it('should print when a sent email was sent', () => {
    const sent = queued('sent', {
      sentAt: '2030-01-01T09:00:04.000Z',
      sentMessageId: '<scheduled@example.com>',
    });
    expect(formatScheduledList([sent])).toEqual([
      '\n✅ Sent (1):',
      '  aaaaaaaa | personal → user@example.com | "Hello" | sent 2030-01-01T09:00:04.000Z',
    ]);
  });

  it('should print the last error of a failed email', () => {
    const failed = queued('failed', { attempts: 3, lastError: 'Max retry attempts exceeded' });
    expect(formatScheduledList([failed])).toEqual([
      '\n❌ Failed (1):',
      '  aaaaaaaa | personal → user@example.com | "Hello" | Max retry attempts exceeded',
    ]);
  });

  it('should list an email that a check is still sending', () => {
    expect(formatScheduledList([queued('sending')])).toEqual([
      '\n📤 Sending (1):',
      '  aaaaaaaa | personal → user@example.com | "Hello" | 2030-01-01T09:00:00.000Z',
    ]);
  });
});
