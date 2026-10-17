/**
 * Bounded wait for an imapflow mailbox lock.
 *
 * imapflow runs one command at a time per connection and queues lock requests
 * with no limit. A command the server never answers holds the queue until the
 * socket times out (300 s by default), and every later tool call on that
 * account waits behind it. A bounded wait turns that into an error the caller
 * sees and can retry.
 */

import type { ImapFlow, MailboxLockObject } from 'imapflow';

/** No single command on a healthy server takes this long; MCP clients often drop a request near it. */
export const MAILBOX_LOCK_TIMEOUT_MS = 60_000;

export default async function lockMailbox(
  client: ImapFlow,
  path: string,
  options: { readOnly?: boolean } = {},
): Promise<MailboxLockObject> {
  try {
    return await client.getMailboxLock(path, {
      ...options,
      acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === 'LockTimeout') {
      throw new Error(
        `Mailbox "${path}" stayed busy for ${MAILBOX_LOCK_TIMEOUT_MS / 1000} s: an earlier operation on this account has not finished. Try again later.`,
        { cause: err },
      );
    }
    throw err;
  }
}
