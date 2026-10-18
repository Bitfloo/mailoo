/** Shared fixtures for the HooksService unit suites. */

import type { Mock } from 'vitest';

import eventBus from '../services/event-bus.js';
import type HooksService from '../services/hooks.service.js';
import type { Email, EmailMeta, HooksConfig } from '../types/index.js';

const alerts = {
  desktop: false,
  sound: false,
  urgencyThreshold: 'high' as const,
  webhookUrl: '',
  webhookEvents: ['urgent' as const, 'high' as const],
};

export function hooksConfig(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return {
    onNewEmail: 'notify',
    preset: 'priority-focus',
    autoLabel: false,
    autoFlag: false,
    batchDelay: 1,
    rules: [],
    alerts,
    ...overrides,
  };
}

export function meta(overrides: Partial<EmailMeta> = {}): EmailMeta {
  return {
    id: '10',
    subject: 'Hello',
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: 'me@example.com' }],
    date: '2026-09-21T00:00:00.000Z',
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    ...overrides,
  };
}

/** The ImapService methods the hooks call; the writes resolve, getEmail is set per suite. */
export interface MockImap {
  addLabel: Mock;
  setFlags: Mock;
  moveEmail: Mock;
  getEmail: Mock;
}

export function mockImap(): MockImap {
  return {
    addLabel: vi.fn().mockResolvedValue(undefined),
    setFlags: vi.fn().mockResolvedValue(undefined),
    moveEmail: vi.fn().mockResolvedValue(undefined),
    getEmail: vi.fn(),
  };
}

export async function flushHooks(emails: EmailMeta[], mailbox = 'INBOX'): Promise<void> {
  eventBus.emit('email:new', { account: 'personal', mailbox, emails });
  await vi.advanceTimersByTimeAsync(1000);
}

/** Same fields ImapService.getEmail returns for a plain-text invitation. */
export function invitation(id: string): Email {
  return {
    ...meta({ id, subject: 'Planning sync', messageId: `<plan-${id}@example.com>` }),
    bodyText: 'Join us Monday at 10:00. https://meet.example.com/abc-defg-hij',
    messageId: `<plan-${id}@example.com>`,
    attachments: [],
    headers: {},
  };
}

/** MockImap plus the reads the calendar auto-add makes. */
export interface CalendarImap extends MockImap {
  getCalendarParts: Mock;
  saveEmailAttachments: Mock;
}

export function calendarImap(email: Email | Error): CalendarImap {
  return {
    ...mockImap(),
    getEmail:
      email instanceof Error ? vi.fn().mockRejectedValue(email) : vi.fn().mockResolvedValue(email),
    getCalendarParts: vi.fn().mockResolvedValue([]),
    saveEmailAttachments: vi.fn().mockResolvedValue([]),
  };
}

/** Awaits flushBatch directly: the batch timer gives no promise to await before the state write. */
export async function runBatch(
  service: HooksService,
  emails: EmailMeta[],
  account = 'personal',
): Promise<void> {
  eventBus.emit('email:new', { account, mailbox: 'INBOX', emails });
  await (service as unknown as { flushBatch: () => Promise<void> }).flushBatch();
}
