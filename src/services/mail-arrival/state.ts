import type { EmailMeta } from '../../types/index.js';
import type { SenderAuthSignals } from '../../utils/auth-headers.js';
import { preferRicherPlain, stripReplyChain } from '../../utils/email-body.js';

export interface ArrivalEmail {
  account: string;
  mailbox: string;
  meta: EmailMeta;
}

export interface MailState {
  message: {
    sender: { display_name: string; email: string };
    subject: string;
    body: string;
    links: readonly { text: string; url: string }[];
    attachments: readonly { filename: string; mime: string }[];
  };
  auth: {
    spf?: string;
    dkim: readonly { result: string; domain?: string }[];
    dmarc?: string;
    fromDomain?: string;
    replyToDomain?: string;
    returnPathDomain?: string;
    hasListUnsubscribe: boolean;
  };
  mailbox: { account: string; folder: string };
}

const URL_RE = /https?:\/\/[^\s<>"'\\)]+/gi;

export function extractLinks(text: string): { text: string; url: string }[] {
  const links: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  const matches = text.match(URL_RE) ?? [];
  matches.forEach((raw) => {
    const url = raw.replace(/[.,;:!?)]+$/u, '');
    if (!url || seen.has(url)) return;
    seen.add(url);
    links.push({ text: url, url });
  });
  return links;
}

function truncateBody(bodyText: string, bodyMaxChars: number): string {
  const stripped = stripReplyChain(preferRicherPlain(bodyText, undefined));
  if (stripped.length <= bodyMaxChars) return stripped;
  return stripped.slice(0, bodyMaxChars);
}

export function buildMailState(input: {
  email: ArrivalEmail;
  security: SenderAuthSignals;
  bodyText: string;
  attachmentNames: readonly { filename: string; mime: string }[];
  includeBody: boolean;
  bodyMaxChars: number;
}): MailState {
  const body = input.includeBody ? truncateBody(input.bodyText, input.bodyMaxChars) : '';
  const links = extractLinks(
    input.includeBody ? `${input.email.meta.subject}\n${body}` : input.email.meta.subject,
  );

  return {
    message: {
      sender: {
        display_name: input.email.meta.from.name ?? '',
        email: input.email.meta.from.address,
      },
      subject: input.email.meta.subject,
      body,
      links,
      attachments: input.attachmentNames,
    },
    auth: {
      spf: input.security.spf,
      dkim: input.security.dkim.map((d) => ({ result: d.result, domain: d.domain })),
      dmarc: input.security.dmarc,
      fromDomain: input.security.fromDomain,
      replyToDomain: input.security.replyToDomain,
      returnPathDomain: input.security.returnPathDomain,
      hasListUnsubscribe: input.security.hasListUnsubscribe,
    },
    mailbox: { account: input.email.account, folder: input.email.mailbox },
  };
}
