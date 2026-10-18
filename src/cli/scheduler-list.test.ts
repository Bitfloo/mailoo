import type { ScheduledEmail } from '../types/index.js';
import { formatScheduledList } from './scheduler.js';

function queued(status: ScheduledEmail['status']): ScheduledEmail {
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
  };
}

describe('scheduler list command', () => {
  it('should list an email that a check is still sending', () => {
    expect(formatScheduledList([queued('sending')])).toEqual([
      '\n📤 Sending (1):',
      '  aaaaaaaa | personal → user@example.com | "Hello" | 2030-01-01T09:00:00.000Z',
    ]);
  });
});
