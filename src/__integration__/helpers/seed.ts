import { setTimeout as sleep } from 'node:timers/promises';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { getGreenMailPorts } from './config.js';

/**
 * A message is readable over IMAP only once GreenMail has filed it, which the
 * SMTP reply does not promise. Delivery takes milliseconds; 10 s turns a message
 * that never arrives into a named failure well inside the 30 s test timeout.
 */
const DELIVERY_DEADLINE_MS = 10_000;
const DELIVERY_POLL_MS = 50;

interface SeedEmailOptions {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  inReplyTo?: string;
  references?: string[];
  attachments?: {
    filename: string;
    content: string | Buffer;
    contentType?: string;
  }[];
  /** nodemailer sends this as a text/calendar alternative plus an invite.ics attachment. */
  icalEvent?: { method?: string; content: string };
  /** Extra body alternatives, sent inline with no Content-Disposition. */
  alternatives?: { contentType: string; content: string }[];
}

function createTransport(user = 'test') {
  const { host, smtpPort } = getGreenMailPorts();
  return nodemailer.createTransport({
    host,
    port: smtpPort,
    secure: false,
    auth: { user, pass: user },
    tls: { rejectUnauthorized: false },
  });
}

export async function seedEmail(options: SeedEmailOptions = {}) {
  const from = options.from ?? 'sender@localhost';
  const user = from.split('@')[0];
  const transport = createTransport(user);
  try {
    const info = await transport.sendMail({
      from,
      to: options.to ?? 'test@localhost',
      subject: options.subject ?? 'Test Email',
      text: options.text ?? 'Hello from integration tests',
      html: options.html,
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      inReplyTo: options.inReplyTo,
      references: options.references?.join(' '),
      attachments: options.attachments,
      icalEvent: options.icalEvent,
      alternatives: options.alternatives,
    });
    return info.messageId;
  } finally {
    transport.close();
  }
}

export async function seedEmails(count: number, options: SeedEmailOptions = {}) {
  const messageIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const messageId = await seedEmail({
      ...options,
      subject: options.subject ?? `Test Email ${i + 1}`,
    });
    messageIds.push(messageId);
  }
  return messageIds;
}

export async function seedThread(length: number, options: SeedEmailOptions = {}) {
  const messageIds: string[] = [];
  const allRefs: string[] = [];

  for (let i = 0; i < length; i++) {
    const from = i % 2 === 0 ? 'alice@localhost' : 'test@localhost';
    const to = i % 2 === 0 ? 'test@localhost' : 'alice@localhost';

    const messageId = await seedEmail({
      from,
      to,
      subject:
        i === 0
          ? (options.subject ?? 'Thread Subject')
          : `Re: ${options.subject ?? 'Thread Subject'}`,
      text: `Message ${i + 1} in thread`,
      inReplyTo: messageIds[i - 1],
      references: allRefs.length > 0 ? [...allRefs] : undefined,
    });

    messageIds.push(messageId);
    allRefs.push(messageId);
  }

  return messageIds;
}

export async function seedEmailWithAttachment(
  filename = 'test.txt',
  content = 'attachment content',
  options: SeedEmailOptions = {},
) {
  return seedEmail({
    ...options,
    subject: options.subject ?? 'Email with attachment',
    attachments: [{ filename, content, contentType: 'text/plain' }],
  });
}

/** Resolve once `count` messages with this subject are in the user's INBOX. */
export async function waitForDelivery(
  subject: string,
  { user = 'test', count = 1 }: { user?: string; count?: number } = {},
): Promise<void> {
  const { host, imapPort } = getGreenMailPorts();
  const client = new ImapFlow({
    host,
    port: imapPort,
    secure: false,
    auth: { user, pass: user },
    logger: false,
  });
  await client.connect();
  try {
    await client.mailboxOpen('INBOX', { readOnly: true });
    const deadline = Date.now() + DELIVERY_DEADLINE_MS;
    while (Date.now() < deadline) {
      await client.noop();
      const uids = await client.search({ subject }, { uid: true });
      if (Array.isArray(uids) && uids.length >= count) return;
      await sleep(DELIVERY_POLL_MS);
    }
    throw new Error(
      `${count} message(s) with subject "${subject}" did not reach ${user}'s INBOX within ${DELIVERY_DEADLINE_MS / 1000} s`,
    );
  } finally {
    await client.logout();
  }
}
