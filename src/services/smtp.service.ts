/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import type { SendMailOptions } from 'nodemailer';
import type { IConnectionManager } from '../connections/types.js';
import { mcpLog } from '../logging.js';
import type RateLimiter from '../safety/rate-limiter.js';
import type { OutgoingAttachment, SendResult } from '../types/index.js';
import compileRfc822 from '../utils/mail-compose.js';
import type ImapService from './imap.service.js';
import {
  MAX_OUTGOING_ATTACHMENT_BYTES,
  resolveOutgoingAttachments,
} from './outgoing-attachments.js';

/** Trailing dots are the FQDN form of the same host. Userinfo stays: this value is a hostname, not a URL. */
function normalizeSmtpHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/u, '');
}

function isHostOrSubdomain(host: string, domain: string): boolean {
  if (host === domain) return true;
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return false;
  const prefix = host.slice(0, -suffix.length);
  if (
    prefix.length === 0 ||
    prefix.startsWith('.') ||
    prefix.endsWith('.') ||
    prefix.includes('..')
  ) {
    return false;
  }
  return true;
}

/** `notgmail.com` and `gmail.com.evil.example` contain the name and are not Gmail. */
function providerFilesSentMail(smtpHost: string, oauthProvider?: string): boolean {
  const host = normalizeSmtpHost(smtpHost);
  return (
    isHostOrSubdomain(host, 'gmail.com') ||
    isHostOrSubdomain(host, 'googlemail.com') ||
    oauthProvider === 'google'
  );
}

function escapeHtml(value: string): string {
  return (value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default class SmtpService {
  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
    private saveToSent = true,
  ) {}

  // -------------------------------------------------------------------------
  // Send email
  // -------------------------------------------------------------------------

  async sendEmail(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      attachments?: OutgoingAttachment[];
      messageId?: string;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const attachments = await this.resolveAttachments(accountName, options.attachments);
    const mail = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      messageId: options.messageId,
      attachments,
      ...(options.html ? { html: options.body } : { text: options.body }),
    };

    return this.sendAndAppend(accountName, mail);
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  async replyToEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      body: string;
      replyAll?: boolean;
      html?: boolean;
      messageId?: string;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Build recipient list
    const to = [original.from.address];
    const cc: string[] = [];

    if (options.replyAll) {
      original.to
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          to.push(addr.address);
        });
      (original.cc ?? [])
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          cc.push(addr.address);
        });
    }

    const references = [...(original.references ?? []), original.messageId].filter(Boolean);

    const subject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    return this.sendAndAppend(accountName, {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      messageId: options.messageId,
      ...(options.html ? { html: options.body } : { text: options.body }),
    });
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  async forwardEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      to: string[];
      body?: string;
      cc?: string[];
      html?: boolean;
      attachments?: OutgoingAttachment[];
      messageId?: string;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);
    const account = this.connections.getAccount(accountName);
    const attachments = await this.resolveAttachments(accountName, options.attachments);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);
    const fromDisplay = original.from.name
      ? `${original.from.name} <${original.from.address}>`
      : original.from.address;
    const toAddresses = original.to.map((a) => a.address).join(', ');
    const mail = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject: original.subject.startsWith('Fwd:') ? original.subject : `Fwd: ${original.subject}`,
      attachments,
      messageId: options.messageId,
    };
    if (options.html) {
      const quote =
        `<br><hr style="border:none;border-top:1px solid #ddd;margin:16px 0"><p style="color:#666;font-size:11pt;margin:0 0 8px">` +
        `<strong>---------- Forwarded message ----------</strong><br>From: ${escapeHtml(fromDisplay)}<br>` +
        `Date: ${escapeHtml(String(original.date))}<br>Subject: ${escapeHtml(original.subject)}<br>` +
        `To: ${escapeHtml(toAddresses)}</p>${
          original.bodyHtml ??
          `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(original.bodyText ?? '')}</pre>`
        }`;
      return this.sendAndAppend(accountName, { ...mail, html: (options.body ?? '') + quote });
    }
    const quote =
      `\n---------- Forwarded message ----------\nFrom: ${fromDisplay}\nDate: ${original.date}\n` +
      `Subject: ${original.subject}\nTo: ${toAddresses}\n`;
    return this.sendAndAppend(accountName, {
      ...mail,
      text: (options.body ?? '') + quote + (original.bodyText ?? original.bodyHtml ?? ''),
    });
  }

  // -------------------------------------------------------------------------
  // Rate limit check
  // -------------------------------------------------------------------------

  private checkRateLimit(accountName: string): void {
    if (!this.rateLimiter.tryConsume(accountName)) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Send draft
  // -------------------------------------------------------------------------

  async sendDraft(accountName: string, draftId: number, mailbox?: string): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    const account = this.connections.getAccount(accountName);
    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');

    const attachments = await Promise.all(
      draft.attachments.map(async (meta) => {
        const downloaded = await this.imapService.downloadAttachment(
          accountName,
          String(draftId),
          draftsPath,
          meta.filename,
          MAX_OUTGOING_ATTACHMENT_BYTES,
        );
        return {
          filename: downloaded.filename,
          content: Buffer.from(downloaded.contentBase64, 'base64'),
          contentType: downloaded.mimeType,
        };
      }),
    );

    const result = await this.sendAndAppend(accountName, {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to,
      cc,
      subject: draft.subject,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      attachments,
      ...(draft.bodyHtml ? { html: draft.bodyHtml } : { text: draft.bodyText ?? '' }),
    });

    await this.imapService.deleteDraft(accountName, draftId, draftsPath);
    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async resolveAttachments(
    accountName: string,
    attachments: OutgoingAttachment[] | undefined,
  ): Promise<{ filename: string; content: Buffer; contentType?: string }[]> {
    const downloadMessageAttachment = async (
      emailId: string,
      mailbox: string,
      filename: string,
      maxBytes: number,
    ) => this.imapService.downloadAttachment(accountName, emailId, mailbox, filename, maxBytes);
    return resolveOutgoingAttachments(attachments, { downloadMessageAttachment });
  }

  private async sendAndAppend(accountName: string, mail: SendMailOptions): Promise<SendResult> {
    const transport = await this.connections.getSmtpTransport(accountName);
    const safeMail: SendMailOptions = {
      ...mail,
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    const result = await transport.sendMail(safeMail);
    const messageId =
      result.messageId ?? (typeof mail.messageId === 'string' ? mail.messageId : '');

    let savedToSent = true;
    try {
      await this.appendSentCopy(accountName, { ...safeMail, messageId });
    } catch (err) {
      savedToSent = false;
      const reason = err instanceof Error ? err.message : String(err);
      await mcpLog('warning', 'smtp', `Failed to append Sent copy: ${reason}`);
    }

    return { messageId, status: 'sent', savedToSent };
  }

  private async appendSentCopy(accountName: string, mail: SendMailOptions): Promise<void> {
    if (!this.saveToSent) return;
    const account = this.connections.getAccount(accountName);
    if (providerFilesSentMail(account.smtp.host, account.oauth2?.provider)) return;

    const raw = await compileRfc822(mail as Record<string, unknown>);
    await this.imapService.appendSentMessage(accountName, raw);
  }
}
