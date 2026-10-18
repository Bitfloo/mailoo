import { readFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImapFlow } from 'imapflow';

import { CALENDAR_ATTACHMENTS_DIR, xdg } from '../config/xdg.js';
import { MAX_MESSAGE_UID } from '../safety/validation.js';
import { INLINE_MAX_BYTES, SAVE_PATH_MAX_BYTES } from '../tools/attachments.tool.js';
import { MAX_THREAD_MESSAGES, SAVED_ATTACHMENT_MAX_BYTES } from './imap.service.js';
import lockMailbox, { MAILBOX_LOCK_TIMEOUT_MS } from './mailbox-lock.js';
import { MAX_OUTGOING_ATTACHMENT_BYTES } from './outgoing-attachments.js';
import { PROTECTED_SPECIAL_USE } from './protected-mailboxes.js';

const docsDir = join(dirname(fileURLToPath(import.meta.url)), '../../docs');
const toolsDoc = join(docsDir, 'tools.md');

/** The text under one `## ` heading of docs/tools.md, line breaks folded to spaces. */
async function docSection(heading: string): Promise<string> {
  const doc = await readFile(toolsDoc, 'utf-8');
  const body = doc.split(/^## /m).find((part) => part.startsWith(heading));
  if (!body) throw new Error(`docs/tools.md has no "## ${heading}" section`);
  return body.replace(/\s+/g, ' ');
}

// docs/tools.md restates these values for users; a change on one side alone fails here.
describe('docs/tools.md', () => {
  it('should list exactly the special-use roles delete_mailbox refuses', async () => {
    const text = await docSection('`delete_mailbox`');

    const roles = [...text.matchAll(/`(\\[A-Za-z]+)`/g)].map((match) => match[1]);

    expect(roles.sort()).toEqual([...PROTECTED_SPECIAL_USE].sort());
  });

  it('should state the mailbox lock timeout in seconds', async () => {
    const text = await docSection('Calls on one account wait');

    expect(text).toContain(`waits at most ${MAILBOX_LOCK_TIMEOUT_MS / 1000} seconds`);
  });

  it('should quote the whole error a busy mailbox returns', async () => {
    const text = await docSection('Calls on one account wait');
    const lockTimeout = Object.assign(new Error('Timed out'), { code: 'LockTimeout' });
    const client = { getMailboxLock: vi.fn().mockRejectedValue(lockTimeout) };

    const message = await lockMailbox(client as unknown as ImapFlow, '<name>').then(
      () => 'lock granted',
      (err: unknown) => (err as Error).message,
    );

    expect(text).toContain(`\`${message}\``);
  });

  it('should state the largest UID bulk_action accepts', async () => {
    const text = await docSection('`bulk_action`');

    expect(text).toContain(`a positive integer up to ${MAX_MESSAGE_UID}`);
  });

  it('should state the size limit of a saved calendar attachment', async () => {
    const text = await docSection('`download_attachment`');

    expect(text).toContain(`up to ${SAVED_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB each`);
  });

  it('should state the size limit of an attachment returned as base64', async () => {
    const text = await docSection('`download_attachment`');

    expect(text).toContain(`capped at **${INLINE_MAX_BYTES / 1024 / 1024} MB**`);
  });

  it('should state the size limit of an attachment written to savePath', async () => {
    const text = await docSection('`download_attachment`');

    expect(text).toContain(`Cap is **${SAVE_PATH_MAX_BYTES / 1024 / 1024} MB**`);
  });

  it('should name the directory calendar attachments are saved in', async () => {
    const text = await docSection('`download_attachment`');
    const underDataHome = relative(dirname(xdg.data), CALENDAR_ATTACHMENTS_DIR)
      .split(sep)
      .join('/');

    expect(text).toContain(`\`$XDG_DATA_HOME/${underDataHome}/\``);
  });

  it('should state the size limit of an outgoing attachment', async () => {
    const text = await docSection('Attachments on send and drafts');

    expect(text).toContain(`at most **${MAX_OUTGOING_ATTACHMENT_BYTES / 1024 / 1024} MB**`);
  });
});

describe('docs/performance-roadmap.md', () => {
  it('should state the get_thread message cap', async () => {
    const doc = await readFile(join(docsDir, 'performance-roadmap.md'), 'utf-8');

    expect(doc).toContain(`Thread reconstruction capped at ${MAX_THREAD_MESSAGES} messages`);
  });
});
