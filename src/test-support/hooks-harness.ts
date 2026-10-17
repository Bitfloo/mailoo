/**
 * Shared fixtures for the HooksService unit suites. Kept out of the suites so each
 * file stays under the 300 code-LOC unit size gate.
 */

import type { Mock } from 'vitest';

import eventBus from '../services/event-bus.js';
import type { EmailMeta, HooksConfig } from '../types/index.js';

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
