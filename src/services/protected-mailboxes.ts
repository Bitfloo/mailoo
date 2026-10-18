/**
 * Folders that delete_mailbox, rename_mailbox and delete_label refuse.
 *
 * The server and every other mail client file into INBOX and the special-use
 * folders (RFC 6154, and RFC 8457 for \Important). Deleting one loses its
 * mail; renaming one leaves the other clients filing into a folder that no
 * longer exists.
 */

import type { ImapFlow } from 'imapflow';

export const PROTECTED_SPECIAL_USE = [
  '\\Trash',
  '\\Sent',
  '\\Drafts',
  '\\Junk',
  '\\Archive',
  '\\All',
  '\\Flagged',
  '\\Important',
];

/** The path imapflow sends: INBOX in any case, and the personal namespace prefix prepended. */
function serverPath(client: ImapFlow, mailboxPath: string): string {
  if (mailboxPath.toUpperCase() === 'INBOX') return 'INBOX';
  // imapflow keeps the NAMESPACE result on the client but does not type it.
  const prefix = (client as unknown as { namespace?: { prefix?: string } }).namespace?.prefix;
  return prefix && !mailboxPath.startsWith(prefix) ? `${prefix}${mailboxPath}` : mailboxPath;
}

export default async function assertMailboxRemovable(
  client: ImapFlow,
  mailboxPath: string,
  action: 'delete' | 'rename',
): Promise<void> {
  const done = action === 'delete' ? 'deleted' : 'renamed';
  const target = serverPath(client, mailboxPath);
  if (target === 'INBOX') {
    throw new Error(`INBOX cannot be ${done}.`);
  }
  // Compared without case: a provider that matches folder names case-insensitively
  // would otherwise act on "[gmail]/trash".
  const lower = target.toLowerCase();
  const mailboxes = await client.list();
  const role = mailboxes
    .filter((mb) => mb.path.toLowerCase() === lower)
    .map((mb) => PROTECTED_SPECIAL_USE.find((f) => mb.specialUse === f || mb.flags?.has(f)))
    .find(Boolean);
  if (role) {
    throw new Error(`"${mailboxPath}" is a special-use folder (${role}) and cannot be ${done}.`);
  }
}
