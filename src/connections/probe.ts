/**
 * One-shot connection checks for the setup wizard and `mailoo test`: log in, report what the
 * server answered, log out. They share the option builders with the connection manager but
 * none of its caching or backoff.
 */

import { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';

import type { AccountConfig } from '../types/index.js';
import { buildImapAuth, buildSmtpAuth, sentCredentials } from './auth.js';
import { redactedError } from './credential-redaction.js';
import { buildImapFlowOptions, buildSmtpTransportOptions } from './manager.js';
import type { AccessTokenSource } from './types.js';

function probeError(account: AccountConfig, err: unknown): string {
  return redactedError(err, sentCredentials(account)).message;
}

export async function testImap(
  account: AccountConfig,
  oauthService?: AccessTokenSource,
): Promise<{
  success: boolean;
  error?: string;
  details?: { messages: number; folders: number };
}> {
  let client: ImapFlow | undefined;
  try {
    const auth = await buildImapAuth(account, oauthService);

    client = new ImapFlow({
      ...buildImapFlowOptions(account),
      auth,
    });
    client.on('error', () => {});
    await client.connect();

    const mailboxes = await client.list();
    let messageCount = 0;
    try {
      const inbox = await client.status('INBOX', {
        messages: true,
        unseen: true,
      });
      if (inbox) messageCount = inbox.messages ?? 0;
    } catch {
      // INBOX may not exist (e.g. Google Workspace uses "All Mail")
      if (mailboxes.length > 0) {
        try {
          const first = await client.status(mailboxes[0].path, {
            messages: true,
          });
          if (first) messageCount = first.messages ?? 0;
        } catch {
          /* ignore — connection still works */
        }
      }
    }

    return {
      success: true,
      details: {
        messages: messageCount,
        folders: mailboxes.length,
      },
    };
  } catch (err) {
    return { success: false, error: probeError(account, err) };
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function testSmtp(
  account: AccountConfig,
  oauthService?: AccessTokenSource,
): Promise<{ success: boolean; error?: string }> {
  let transport: Transporter | undefined;
  try {
    const auth = buildSmtpAuth(account, oauthService);

    transport = nodemailer.createTransport(buildSmtpTransportOptions(account, auth));
    await transport.verify();
    return { success: true };
  } catch (err) {
    return { success: false, error: probeError(account, err) };
  } finally {
    transport?.close();
  }
}
