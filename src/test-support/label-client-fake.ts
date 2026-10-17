/** imapflow client fake and strategy setups for the label strategy suites. */

import type { ImapFlow } from 'imapflow';
import type { Mock } from 'vitest';

import { detectLabelStrategy } from '../services/label-strategy.js';

type LabelCommand =
  | 'list'
  | 'getMailboxLock'
  | 'messageFlagsAdd'
  | 'messageFlagsRemove'
  | 'messageCopy'
  | 'fetchOne'
  | 'search'
  | 'messageDelete'
  | 'mailboxDelete';

// Written out because tsc cannot name the inferred vi.fn() type in a declaration.
export type LabelClient = Record<LabelCommand, Mock> & {
  capabilities: Set<string>;
  mailbox: { permanentFlags: Set<string> };
  releaseFn: Mock;
};

function mockClient(gmail: boolean): LabelClient {
  const releaseFn = vi.fn();
  return {
    list: vi.fn().mockResolvedValue([]),
    capabilities: new Set(gmail ? ['X-GM-EXT-1'] : []),
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    mailbox: { permanentFlags: new Set(['\\*']) },
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    messageCopy: vi.fn().mockResolvedValue({ path: 'INBOX', destination: 'Labels/Work' }),
    fetchOne: vi.fn().mockResolvedValue(false),
    search: vi.fn().mockResolvedValue([]),
    messageDelete: vi.fn().mockResolvedValue(true),
    mailboxDelete: vi.fn().mockResolvedValue({ path: 'deleted' }),
    releaseFn,
  };
}

/** Gmail LIST: system folders carry RFC 6154 roles, user labels carry none. */
export const GMAIL_LIST = [
  { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox', flags: new Set<string>() },
  { name: 'Trash', path: '[Gmail]/Trash', specialUse: '\\Trash', flags: new Set(['\\Trash']) },
  {
    name: 'Sent Mail',
    path: '[Gmail]/Sent Mail',
    specialUse: '\\Sent',
    flags: new Set(['\\Sent']),
  },
  { name: 'Receipts', path: 'Receipts', flags: new Set<string>() },
];

export async function keywordStrategy() {
  const client = mockClient(false);
  const strategy = await detectLabelStrategy(client as unknown as ImapFlow);
  expect(strategy.type).toBe('keyword');
  return { client, strategy };
}

export async function gmailStrategy() {
  const client = mockClient(true);
  const strategy = await detectLabelStrategy(client as unknown as ImapFlow);
  expect(strategy.type).toBe('gmail');
  return { client, strategy };
}

/** ProtonMail Bridge lists its labels under a \\Noselect "Labels" folder. */
export async function protonStrategy() {
  const client = mockClient(false);
  client.list.mockResolvedValue([
    { name: 'Labels', path: 'Labels', flags: new Set(['\\Noselect']) },
  ]);
  const strategy = await detectLabelStrategy(client as unknown as ImapFlow);
  expect(strategy.type).toBe('protonmail');
  return { client, strategy };
}

/** Records which mailbox the last lock selected when each command ran. */
export function recordSelectedMailbox(client: LabelClient) {
  let selected = '';
  const ranIn: string[] = [];
  client.getMailboxLock.mockImplementation(async (path: string) => {
    selected = path;
    return { release: client.releaseFn };
  });
  const record = (result: unknown) => async () => {
    ranIn.push(selected);
    return result;
  };
  return { ranIn, record };
}
