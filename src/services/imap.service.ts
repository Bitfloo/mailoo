/**
 * IMAP service — pure business logic for email read operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import { join } from 'node:path';
import type { ImapFlow } from 'imapflow';
import type { IConnectionManager } from '../connections/types.js';
import { sanitizeAttachmentFilename } from '../safety/local-paths.js';
import {
  parseMessageUid,
  sanitizeMailboxName,
  sanitizeSearchQuery,
  validateLabelName,
} from '../safety/validation.js';
import type {
  AttachmentMeta,
  BulkResult,
  Contact,
  DailyVolume,
  Email,
  EmailAddress,
  EmailMeta,
  EmailStats,
  LabelInfo,
  Mailbox,
  OutgoingAttachment,
  PaginatedResult,
  QuotaInfo,
  SenderStat,
} from '../types/index.js';
import { parseSenderAuth } from '../utils/auth-headers.js';
import { looksLikeRawMime, preferRicherPlain, stripHtml } from '../utils/email-body.js';
import compileRfc822 from '../utils/mail-compose.js';
import type { LabelStrategy } from './label-strategy.js';
import { detectLabelStrategy } from './label-strategy.js';
import type { SavedAttachment } from './local-calendar.service.js';
import lockMailbox from './mailbox-lock.js';
import { resolveOutgoingAttachments } from './outgoing-attachments.js';
import assertMailboxRemovable from './protected-mailboxes.js';

// ---------------------------------------------------------------------------
// Helpers (must be defined before ImapService)
// ---------------------------------------------------------------------------

function parseAddress(addr: { name?: string; address?: string } | undefined): EmailAddress {
  return {
    name: addr?.name ?? undefined,
    address: addr?.address ?? 'unknown',
  };
}

function parseAddresses(addrs: { name?: string; address?: string }[] | undefined): EmailAddress[] {
  if (!addrs) return [];
  return addrs.map(parseAddress);
}

function hasAttachments(bodyStructure: unknown): boolean {
  if (!bodyStructure || typeof bodyStructure !== 'object') return false;
  const bs = bodyStructure as Record<string, unknown>;
  if (bs.disposition === 'attachment') return true;
  if (Array.isArray(bs.childNodes)) {
    return bs.childNodes.some((child: unknown) => hasAttachments(child));
  }
  return false;
}

function mimeTypeOf(bs: Record<string, unknown>): string {
  const raw = String(bs.type ?? '');
  if (raw.includes('/')) return raw.toLowerCase();
  const subtype = String(bs.subtype ?? '');
  if (raw && subtype) return `${raw.toLowerCase()}/${subtype.toLowerCase()}`;
  return raw.toLowerCase();
}

/**
 * Content-Type and Content-Disposition parameters of a part; the disposition's
 * value wins on a shared key. imapflow sets dispositionParameters whenever that
 * header carries any parameter, so it may hold a size= and no filename.
 */
function partParameters(bs: Record<string, unknown>): Record<string, string> {
  return {
    ...(bs.parameters as Record<string, string> | undefined),
    ...(bs.dispositionParameters as Record<string, string> | undefined),
  };
}

interface AttachmentPart extends AttachmentMeta {
  /** IMAP part number (BODY[part]); empty for the root of a single-part message. */
  part: string;
}

/**
 * Every attachment with its MIME part number, in BODYSTRUCTURE order. A filename
 * is not unique within a message, so a download needs the part number.
 */
function listAttachmentParts(bodyStructure: unknown, partPath = ''): AttachmentPart[] {
  const attachments: AttachmentPart[] = [];
  if (!bodyStructure || typeof bodyStructure !== 'object') return attachments;

  const bs = bodyStructure as Record<string, unknown>;
  const effectivePath = (bs.part as string | undefined) ?? partPath;
  if (bs.disposition === 'attachment') {
    const params = partParameters(bs);
    attachments.push({
      filename: params.filename ?? params.name ?? 'unnamed',
      mimeType: mimeTypeOf(bs) || 'application/octet-stream',
      size: (bs.size as number) ?? 0,
      part: effectivePath,
    });
  }

  if (Array.isArray(bs.childNodes)) {
    (bs.childNodes as unknown[]).forEach((child, i) => {
      const childPart = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      attachments.push(...listAttachmentParts(child, childPart));
    });
  }

  return attachments;
}

function extractAttachments(bodyStructure: unknown): AttachmentMeta[] {
  return listAttachmentParts(bodyStructure).map(({ filename, mimeType, size }) => ({
    filename,
    mimeType,
    size,
  }));
}

/** A file name not yet used in this directory; compared without case for case-insensitive disks. */
function uniqueFilename(name: string, used: Set<string>): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  // eslint-disable-next-line no-plusplus
  for (let n = 2; used.has(candidate.toLowerCase()); n++) {
    candidate = `${stem}-${n}${ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

export interface TextMimeParts {
  plain?: string;
  html?: string;
}

/**
 * Walk ImapFlow bodyStructure and return the first non-attachment text/plain
 * and text/html leaf part numbers. Skips message/rfc822 subtrees.
 */
export function findTextMimeParts(bodyStructure: unknown, partPath = ''): TextMimeParts {
  if (!bodyStructure || typeof bodyStructure !== 'object') return {};
  const bs = bodyStructure as Record<string, unknown>;
  const mime = mimeTypeOf(bs);
  if (bs.disposition === 'attachment') return {};
  if (mime === 'message/rfc822' || mime.startsWith('message/')) return {};

  const currentPart = (typeof bs.part === 'string' && bs.part ? bs.part : partPath) || '1';
  const here: TextMimeParts = {};
  if (mime === 'text/plain') here.plain = currentPart;
  if (mime === 'text/html') here.html = currentPart;

  if (!Array.isArray(bs.childNodes)) return here;

  return bs.childNodes.reduce<TextMimeParts>((acc, child: unknown, i: number) => {
    const childRecord = child as Record<string, unknown> | undefined;
    const childPart =
      (typeof childRecord?.part === 'string' && childRecord.part) ||
      (currentPart && currentPart !== '1' ? `${currentPart}.${i + 1}` : String(i + 1));
    const nested = findTextMimeParts(child, childPart);
    return {
      plain: acc.plain ?? nested.plain,
      html: acc.html ?? nested.html,
    };
  }, here);
}

/** Content of one MIME part with its transfer encoding (base64, quoted-printable) removed. */
async function downloadPart(
  client: ImapFlow,
  uid: string,
  part: string,
): Promise<Buffer | undefined> {
  const downloaded = await client.download(uid, part, { uid: true });
  if (!downloaded?.content) return undefined;
  const chunks: Buffer[] = [];
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of downloaded.content) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function downloadMimePart(
  client: ImapFlow,
  uid: number,
  part: string,
): Promise<string | undefined> {
  try {
    const content = await downloadPart(client, String(uid), part);
    if (!content) return undefined;
    const text = content.toString('utf-8');
    if (looksLikeRawMime(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/** Default per-attachment limit for saveEmailAttachments. */
export const SAVED_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Download each part by number and write it under destDir. Two attachments may
 * share a filename, and each gets its own file instead of the first one written twice.
 */
async function writeAttachmentParts(
  client: ImapFlow,
  uid: string,
  parts: AttachmentPart[],
  destDir: string,
): Promise<SavedAttachment[]> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(destDir, { recursive: true });
  const saved: SavedAttachment[] = [];
  const usedNames = new Set<string>();
  // eslint-disable-next-line no-restricted-syntax
  for (const meta of parts) {
    const name = uniqueFilename(sanitizeAttachmentFilename(meta.filename), usedNames);
    const localPath = join(destDir, name);
    try {
      // imapflow runs one command at a time per connection.
      // eslint-disable-next-line no-await-in-loop
      const content = meta.part ? await downloadPart(client, uid, meta.part) : undefined;
      if (content) {
        // eslint-disable-next-line no-await-in-loop
        await writeFile(localPath, content);
        saved.push({
          filename: meta.filename,
          localPath,
          fileUrl: `file://${localPath}`,
          mimeType: meta.mimeType,
          size: content.length,
        });
      }
    } catch {
      // Best effort: an unreadable part or a failed write skips that attachment only.
    }
  }
  return saved;
}

/** get_thread fetches each message in full; a mailing-list thread can run to hundreds. */
export const MAX_THREAD_MESSAGES = 50;

const THREAD_HEADERS = ['Message-ID', 'References', 'In-Reply-To'];

/** Every Message-ID a fetched header block names, unfolding continuation lines first. */
function threadIdsInHeaders(headers: Buffer | undefined): string[] {
  if (!headers) return [];
  return headers
    .toString('utf-8')
    .replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/)
    .filter((line) => /^(message-id|references|in-reply-to):/i.test(line))
    .flatMap((line) => line.match(/<[^<>\s]+>/g) ?? []);
}

/* eslint-disable no-await-in-loop, no-restricted-syntax -- imapflow runs one command at a time */
/** UIDs whose Message-ID is id, or whose References or In-Reply-To names it. */
async function searchThreadHeaders(client: ImapFlow, id: string): Promise<number[]> {
  const uids: number[] = [];
  for (const header of THREAD_HEADERS) {
    try {
      const result = await client.search({ header: { [header]: id } }, { uid: true });
      if (Array.isArray(result)) uids.push(...result);
    } catch {
      // Header search may fail on some servers
    }
  }
  return uids;
}

/** Add every Message-ID the thread headers of these messages name to ids. */
async function collectThreadIds(client: ImapFlow, uids: number[], ids: Set<string>): Promise<void> {
  const rows = await client.fetchAll(
    uids.join(','),
    { uid: true, headers: THREAD_HEADERS },
    { uid: true },
  );
  for (const id of rows.flatMap((row) => threadIdsInHeaders(row.headers))) ids.add(id);
}

/**
 * UIDs of the thread around messageId, at most max. A reply may name only the
 * message it answers, in In-Reply-To, so the ids of every message found are
 * searched in turn until no new message turns up.
 */
async function findThreadUids(client: ImapFlow, messageId: string, max: number): Promise<number[]> {
  const ids = new Set([messageId]);
  const searched = new Set<string>();
  const found = new Set<number>();
  const read = new Set<number>();
  let unread: number[] = [];
  do {
    for (const id of [...ids].filter((known) => !searched.has(known))) {
      if (found.size >= max) break;
      searched.add(id);
      for (const uid of await searchThreadHeaders(client, id)) found.add(uid);
    }
    unread = [...found].filter((uid) => !read.has(uid));
    if (unread.length > 0 && found.size < max) {
      for (const uid of unread) read.add(uid);
      await collectThreadIds(client, unread, ids);
    }
  } while (unread.length > 0 && found.size < max);
  return [...found].slice(0, max);
}
/* eslint-enable no-await-in-loop, no-restricted-syntax */

const DEFAULT_DATE_SORT_WINDOW = 250;
const FALLBACK_SOURCE_MAX_BYTES = 65_536;
const LIST_PREVIEW_SOURCE_MAX_BYTES = 4096;
// In-Reply-To rides along because some servers (GreenMail among them) leave it out of ENVELOPE.
const MESSAGE_HEADER_FIELDS = ['references', 'in-reply-to', 'content-type'];

function parseHeaderBlock(headerBlock: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
  unfolded.split(/\r?\n/).forEach((line) => {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      if (key) {
        headers[key] = headers[key] ? `${headers[key]} ${value}` : value;
      }
    }
  });
  return headers;
}

export function extractReferences(
  msg: Record<string, unknown>,
  parsedHeaders?: Record<string, string>,
): string[] | undefined {
  if (parsedHeaders?.references) {
    const refs = parsedHeaders.references.split(/\s+/).filter(Boolean);
    if (refs.length > 0) return refs;
  }

  if (msg.headers) {
    let rawHeaders = '';
    if (Buffer.isBuffer(msg.headers)) {
      rawHeaders = msg.headers.toString('utf-8');
    } else if (typeof msg.headers === 'string') {
      rawHeaders = msg.headers;
    }
    if (rawHeaders) {
      const hdrs = parseHeaderBlock(rawHeaders);
      if (hdrs.references) {
        const refs = hdrs.references.split(/\s+/).filter(Boolean);
        if (refs.length > 0) return refs;
      }
    }
  }

  if (msg.source && Buffer.isBuffer(msg.source)) {
    const src = msg.source.toString('utf-8');
    const headerEnd = src.indexOf('\r\n\r\n');
    const headerSlice = headerEnd >= 0 ? src.slice(0, headerEnd) : src;
    const hdrs = parseHeaderBlock(headerSlice);
    if (hdrs.references) {
      const refs = hdrs.references.split(/\s+/).filter(Boolean);
      if (refs.length > 0) return refs;
    }
  }

  return undefined;
}

function cleanPreviewCandidate(raw: string): string | undefined {
  let text = raw;
  // If candidate starts with a MIME boundary, skip boundary + MIME part headers
  for (let depth = 0; depth < 3 && text.trimStart().startsWith('--'); depth += 1) {
    const trimmed = text.trimStart();
    const partBodySep = trimmed.indexOf('\r\n\r\n');
    const lfPartSep = trimmed.indexOf('\n\n');
    if (partBodySep >= 0) {
      text = trimmed.slice(partBodySep + 4);
    } else if (lfPartSep >= 0) {
      text = trimmed.slice(lfPartSep + 2);
    } else {
      break;
    }
  }
  const nextBoundary = text.search(/\r?\n--[^\s]/);
  if (nextBoundary >= 0) {
    text = text.slice(0, nextBoundary);
  }
  if (looksLikeRawMime(text)) return undefined;
  const stripped = stripHtml(text).replace(/\s+/g, ' ').trim();
  return stripped ? stripped.slice(0, 200) : undefined;
}

function extractPreview(msg: Record<string, unknown>): string | undefined {
  // 1. Prefer decoded/fetched MIME text part from bodyParts Map when present
  if (msg.bodyParts instanceof Map && msg.bodyParts.size > 0) {
    const textParts = findTextMimeParts(msg.bodyStructure);
    const preferredKeys = [
      textParts.plain,
      '1.1',
      '1',
      'text',
      textParts.html,
      ...Array.from(msg.bodyParts.keys()).map(String),
    ].filter((k): k is string => Boolean(k));

    // eslint-disable-next-line no-restricted-syntax
    for (const key of preferredKeys) {
      const buf = msg.bodyParts.get(key) ?? msg.bodyParts.get(key.toLowerCase());
      if (Buffer.isBuffer(buf) && buf.length > 0) {
        const candidate = cleanPreviewCandidate(buf.toString('utf-8'));
        if (candidate) return candidate;
      }
    }
  }

  // 2. Fallback to source slice (after RFC 822 headers)
  if (msg.source && Buffer.isBuffer(msg.source)) {
    const rawText = msg.source.toString('utf-8');
    const crlfStart = rawText.indexOf('\r\n\r\n');
    const lfStart = rawText.indexOf('\n\n');
    let bodySlice: string | undefined;
    if (crlfStart >= 0) {
      bodySlice = rawText.slice(crlfStart + 4);
    } else if (lfStart >= 0) {
      bodySlice = rawText.slice(lfStart + 2);
    }
    if (bodySlice) {
      return cleanPreviewCandidate(bodySlice);
    }
  }

  return undefined;
}

async function orderUidsByDate(
  client: ImapFlow,
  uids: number[],
  maxWindow = DEFAULT_DATE_SORT_WINDOW,
): Promise<number[]> {
  if (uids.length === 0) return [];
  const sortedAsc = [...uids].sort((a, b) => a - b);
  const windowSize = Math.max(maxWindow, DEFAULT_DATE_SORT_WINDOW);
  const tailUids = sortedAsc.length > windowSize ? sortedAsc.slice(-windowSize) : sortedAsc;
  const olderUidsDesc =
    sortedAsc.length > windowSize ? sortedAsc.slice(0, -windowSize).reverse() : [];

  const seenInFetch = new Set<number>();
  const dated: { uid: number; t: number }[] = [];
  // eslint-disable-next-line no-restricted-syntax
  for await (const msg of client.fetch(
    tailUids.join(','),
    { uid: true, envelope: true },
    { uid: true },
  )) {
    const raw = msg as unknown as Record<string, unknown>;
    const uid = raw.uid as number;
    seenInFetch.add(uid);
    const envelope = (raw.envelope ?? {}) as Record<string, unknown>;
    const parsed = envelope.date ? new Date(envelope.date as string).getTime() : Number.NaN;
    dated.push({
      uid,
      t: Number.isNaN(parsed) ? uid : parsed,
    });
  }
  dated.sort((a, b) => b.t - a.t || b.uid - a.uid);
  const missingTailDesc = tailUids.filter((u) => !seenInFetch.has(u)).reverse();
  return [...dated.map((d) => d.uid), ...missingTailDesc, ...olderUidsDesc];
}

function messageToEmailMeta(msg: Record<string, unknown>): EmailMeta {
  const envelope = (msg.envelope ?? {}) as Record<string, unknown>;
  const flags = new Set((msg.flags ?? []) as string[]);

  // Extract non-system flags as labels (IMAP keywords)
  const labels = [...flags].filter((f) => !f.startsWith('\\'));

  const preview = extractPreview(msg);

  return {
    id: String(msg.uid ?? msg.seq),
    subject: (envelope.subject as string) ?? '(no subject)',
    from: parseAddress((envelope.from as Record<string, string>[])?.[0]),
    to: parseAddresses(envelope.to as Record<string, string>[]),
    date: envelope.date
      ? new Date(envelope.date as string).toISOString()
      : new Date().toISOString(),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: hasAttachments(msg.bodyStructure),
    labels,
    preview,
    messageId: (envelope.messageId as string) ?? undefined,
  };
}

async function messageToEmail(
  msg: Record<string, unknown>,
  client: ImapFlow,
  uid: number,
): Promise<Email> {
  const meta = messageToEmailMeta(msg);
  const envelope = (msg.envelope ?? {}) as Record<string, unknown>;

  let bodyText: string | undefined;
  let bodyHtml: string | undefined;
  let headers: Record<string, string> = {};

  if (msg.headers) {
    let rawHeaders = '';
    if (Buffer.isBuffer(msg.headers)) {
      rawHeaders = msg.headers.toString('utf-8');
    } else if (typeof msg.headers === 'string') {
      rawHeaders = msg.headers;
    }
    if (rawHeaders) {
      headers = parseHeaderBlock(rawHeaders);
    }
  }

  const parts = findTextMimeParts(msg.bodyStructure);
  if (parts.plain) {
    const plain = await downloadMimePart(client, uid, parts.plain);
    if (plain !== undefined) bodyText = plain;
  }
  if (parts.html) {
    const html = await downloadMimePart(client, uid, parts.html);
    if (html !== undefined) bodyHtml = html;
  }

  let sourceBuffer = Buffer.isBuffer(msg.source) ? msg.source : undefined;
  if (!parts.plain && !parts.html && !sourceBuffer) {
    try {
      const fallbackMsg = await client.fetchOne(
        String(uid),
        { uid: true, source: { start: 0, maxLength: FALLBACK_SOURCE_MAX_BYTES } },
        { uid: true },
      );
      if (fallbackMsg && typeof fallbackMsg === 'object' && 'source' in fallbackMsg) {
        const fbSource = (fallbackMsg as unknown as Record<string, unknown>).source;
        if (Buffer.isBuffer(fbSource)) {
          sourceBuffer = fbSource;
        }
      }
    } catch {
      // Ignore fallback fetch errors
    }
  }

  if (sourceBuffer) {
    const raw = sourceBuffer.toString('utf-8');
    const headerEnd = raw.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const parsedFromSource = parseHeaderBlock(raw.slice(0, headerEnd));
      headers = { ...parsedFromSource, ...headers };

      if (bodyText === undefined && bodyHtml === undefined) {
        const body = raw.slice(headerEnd + 4);
        const contentType = (headers['content-type'] ?? '').toLowerCase();
        if (contentType.includes('multipart/')) {
          // Container — leaf parts are downloaded above.
        } else if (contentType.includes('text/html')) {
          bodyHtml = body;
        } else {
          bodyText = body;
        }
      }
    }
  }

  return {
    ...meta,
    preview: meta.preview ?? (bodyText ? cleanPreviewCandidate(bodyText) : undefined),
    cc: parseAddresses(envelope.cc as Record<string, string>[]),
    bcc: parseAddresses(envelope.bcc as Record<string, string>[]),
    bodyText,
    bodyHtml,
    messageId: (envelope.messageId as string) ?? '',
    inReplyTo: (envelope.inReplyTo as string | undefined) ?? headers['in-reply-to'],
    references: extractReferences(msg, headers),
    attachments: extractAttachments(msg.bodyStructure),
    headers,
  };
}

/**
 * `<YYYY-MM-DD>_<uid>.eml`. The day is taken in UTC: the process time zone
 * would otherwise give the same message a different name on another machine.
 */
export function emlFilename(internalDate: Date | string | undefined, uid: string): string {
  const date = internalDate instanceof Date ? internalDate : new Date(internalDate ?? Number.NaN);
  const day = Number.isNaN(date.getTime()) ? 'undated' : date.toISOString().slice(0, 10);
  return sanitizeAttachmentFilename(`${day}_${uid}.eml`);
}

/** UID set for a bulk action. Each id must be one canonical UID, as for single-message tools. */
function bulkUidSet(ids: number[]): string {
  return ids.map((id) => parseMessageUid(String(id))).join(',');
}

function exportTooLarge(uid: string, size: number, maxSizeBytes: number): Error {
  return new Error(`Email ${uid} is ${size} bytes, over the ${maxSizeBytes}-byte limit`);
}

export const FLAG_ACTIONS = ['read', 'unread', 'flag', 'unflag'] as const;

export type FlagAction = (typeof FLAG_ACTIONS)[number];

const flagChange: Record<FlagAction, { flags: string[]; add: boolean }> = {
  read: { flags: ['\\Seen'], add: true },
  unread: { flags: ['\\Seen'], add: false },
  flag: { flags: ['\\Flagged'], add: true },
  unflag: { flags: ['\\Flagged'], add: false },
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export default class ImapService {
  private labelStrategies = new Map<string, LabelStrategy>();

  private labelStrategyPending = new Map<string, Promise<LabelStrategy>>();

  constructor(private connections: IConnectionManager) {}

  resolveAccountName(accountName?: string): string {
    if (typeof this.connections.resolveAccountName === 'function') {
      return this.connections.resolveAccountName(accountName);
    }
    return this.connections.getAccount(accountName ?? '').name;
  }

  private async getLabelStrategy(accountName: string): Promise<LabelStrategy> {
    const cached = this.labelStrategies.get(accountName);
    if (cached) return cached;

    // Deduplicate concurrent detection for the same account
    const pending = this.labelStrategyPending.get(accountName);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const client = await this.connections.getImapClient(accountName);
        const strategy = await detectLabelStrategy(client);
        this.labelStrategies.set(accountName, strategy);
        return strategy;
      } finally {
        // Only a success is cached; a failed detection is retried on the next call.
        this.labelStrategyPending.delete(accountName);
      }
    })();

    this.labelStrategyPending.set(accountName, promise);
    return promise;
  }

  // -------------------------------------------------------------------------
  // Mailboxes
  // -------------------------------------------------------------------------

  async listMailboxes(accountName: string): Promise<Mailbox[]> {
    const client = await this.connections.getImapClient(accountName);
    const mailboxes = await client.list();

    const statusResults = await Promise.allSettled(
      mailboxes.map(async (mb) => {
        const status = await client.status(mb.path, {
          messages: true,
          unseen: true,
        });
        return {
          name: mb.name,
          path: mb.path,
          specialUse: mb.specialUse ?? undefined,
          totalMessages: status.messages ?? 0,
          unseenMessages: status.unseen ?? 0,
        };
      }),
    );

    return statusResults.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // Fallback for folders that don't support STATUS (e.g. \Noselect)
      const mb = mailboxes[idx];
      return {
        name: mb.name,
        path: mb.path,
        specialUse: mb.specialUse ?? undefined,
        totalMessages: 0,
        unseenMessages: 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // List emails
  // -------------------------------------------------------------------------

  async listEmails(
    accountName: string,
    options: {
      mailbox?: string;
      page?: number;
      pageSize?: number;
      since?: string;
      before?: string;
      from?: string;
      subject?: string;
      seen?: boolean;
      flagged?: boolean;
      hasAttachment?: boolean;
      answered?: boolean;
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = sanitizeMailboxName(options.mailbox ?? 'INBOX');
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;

    const lock = await lockMailbox(client, mailbox);
    try {
      // Build search criteria
      const search: Record<string, unknown> = {};
      if (options.since) search.since = new Date(options.since);
      if (options.before) search.before = new Date(options.before);
      if (options.from) search.from = options.from;
      if (options.subject) search.subject = options.subject;
      if (options.seen !== undefined) search.seen = options.seen;
      if (options.flagged !== undefined) search.flagged = options.flagged;
      if (options.answered !== undefined) search.answered = options.answered;

      // Search for matching UIDs
      const searchResult = await client.search(search, { uid: true });
      let uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      // Post-filter for hasAttachment (IMAP has no native attachment search)
      if (options.hasAttachment !== undefined && uids.length > 0) {
        const filteredUids: number[] = [];
        // eslint-disable-next-line no-restricted-syntax
        for await (const msg of client.fetch(
          uids.join(','),
          { uid: true, bodyStructure: true },
          { uid: true },
        )) {
          const raw = msg as unknown as Record<string, unknown>;
          if (options.hasAttachment === hasAttachments(raw.bodyStructure)) {
            filteredUids.push(raw.uid as number);
          }
        }
        uids = filteredUids;
      }

      if (uids.length === 0) {
        return {
          items: [],
          total: 0,
          page,
          pageSize,
          hasMore: false,
        };
      }

      // Sort by date (newest first), then paginate — UID order is not date order
      uids = await orderUidsByDate(
        client,
        uids,
        Math.max(page * pageSize * 3, DEFAULT_DATE_SORT_WINDOW),
      );
      const total = uids.length;
      const start = (page - 1) * pageSize;
      const pageUids = uids.slice(start, start + pageSize);

      if (pageUids.length === 0) {
        return {
          items: [],
          total,
          page,
          pageSize,
          hasMore: false,
        };
      }

      const items: EmailMeta[] = [];
      const range = pageUids.join(',');

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          source: { start: 0, maxLength: LIST_PREVIEW_SOURCE_MAX_BYTES },
        },
        { uid: true },
      )) {
        items.push(messageToEmailMeta(msg as unknown as Record<string, unknown>));
      }

      // Sort by date descending
      items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return {
        items,
        total,
        page,
        pageSize,
        hasMore: start + pageSize < total,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Get single email
  // -------------------------------------------------------------------------

  async getEmail(accountName: string, emailId: string, mailbox = 'INBOX'): Promise<Email> {
    const uidText = parseMessageUid(emailId);
    const uid = Number(uidText);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);

    const lock = await lockMailbox(client, safeMailbox);
    try {
      const msg = await client.fetchOne(
        uidText,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          headers: MESSAGE_HEADER_FIELDS,
        },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      return await messageToEmail(msg as unknown as Record<string, unknown>, client, uid);
    } finally {
      lock.release();
    }
  }

  async getEmails(accountName: string, emailIds: string[], mailbox = 'INBOX'): Promise<Email[]> {
    const uidList = emailIds.map((id) => parseMessageUid(id));
    if (uidList.length === 0) return [];
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);

    const lock = await lockMailbox(client, safeMailbox);
    try {
      // messageToEmail downloads body parts, and a command issued while a FETCH iterator is open
      // never starts, so the rows are collected first.
      const rows = await client.fetchAll(
        uidList.join(','),
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          headers: MESSAGE_HEADER_FIELDS,
        },
        { uid: true },
      );
      const emails: Email[] = [];
      // eslint-disable-next-line no-restricted-syntax
      for (const msg of rows) {
        const raw = msg as unknown as Record<string, unknown>;
        // eslint-disable-next-line no-await-in-loop
        emails.push(await messageToEmail(raw, client, raw.uid as number));
      }
      return emails;
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Get email flags (lightweight — no body fetch, no \Seen change)
  // -------------------------------------------------------------------------

  async getEmailFlags(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
  ): Promise<{
    seen: boolean;
    flagged: boolean;
    answered: boolean;
    labels: string[];
    subject: string;
    from: string;
    date: string;
  }> {
    const uidText = parseMessageUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);

    const lock = await lockMailbox(client, safeMailbox);
    try {
      const msg = await client.fetchOne(
        uidText,
        { uid: true, envelope: true, flags: true },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      const raw = msg as unknown as Record<string, unknown>;
      const flags = new Set((raw.flags ?? []) as string[]);
      const labels = [...flags].filter((f) => !f.startsWith('\\'));
      const envelope = (raw.envelope ?? {}) as Record<string, unknown>;
      const fromEntry = (envelope.from as Record<string, string>[] | undefined)?.[0];
      let from = '';
      if (fromEntry) {
        from = fromEntry.name
          ? `${fromEntry.name} <${fromEntry.address}>`
          : (fromEntry.address ?? '');
      }

      return {
        seen: flags.has('\\Seen'),
        flagged: flags.has('\\Flagged'),
        answered: flags.has('\\Answered'),
        labels,
        subject: (envelope.subject as string) ?? '(no subject)',
        from,
        date: envelope.date ? new Date(envelope.date as string).toISOString() : '',
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Search emails
  // -------------------------------------------------------------------------

  async searchEmails(
    accountName: string,
    query: string,
    options: {
      mailbox?: string;
      page?: number;
      pageSize?: number;
      to?: string;
      hasAttachment?: boolean;
      largerThan?: number;
      smallerThan?: number;
      answered?: boolean;
      since?: string;
      before?: string;
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = sanitizeMailboxName(options.mailbox ?? 'INBOX');
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    const sanitizedQuery = query ? sanitizeSearchQuery(query) : '';

    const lock = await lockMailbox(client, mailbox);
    try {
      // Build search criteria — base query OR across subject/from/body
      const baseCriteria: Record<string, unknown> = sanitizedQuery
        ? { or: [{ subject: sanitizedQuery }, { from: sanitizedQuery }, { body: sanitizedQuery }] }
        : {};

      // Build additional filters as AND conditions
      const andConditions: Record<string, unknown>[] = [baseCriteria];

      if (options.to) {
        andConditions.push({ to: options.to });
      }
      if (options.largerThan !== undefined) {
        andConditions.push({ larger: options.largerThan * 1024 });
      }
      if (options.smallerThan !== undefined) {
        andConditions.push({ smaller: options.smallerThan * 1024 });
      }
      if (options.answered === true) {
        andConditions.push({ answered: true });
      } else if (options.answered === false) {
        andConditions.push({ answered: false });
      }
      if (options.since) {
        andConditions.push({ since: new Date(options.since) });
      }
      if (options.before) {
        andConditions.push({ before: new Date(options.before) });
      }

      // Use the combined criteria or just the base
      const searchCriteria =
        andConditions.length === 1 ? baseCriteria : Object.assign({}, ...andConditions);

      const searchResult = await client.search(searchCriteria, { uid: true });
      let uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      // Post-filter for has_attachment if requested (IMAP doesn't have native support)
      if (options.hasAttachment !== undefined && uids.length > 0) {
        const filteredUids: number[] = [];
        const checkRange = uids.join(',');

        // eslint-disable-next-line no-restricted-syntax
        for await (const msg of client.fetch(
          checkRange,
          { uid: true, bodyStructure: true },
          { uid: true },
        )) {
          const raw = msg as unknown as Record<string, unknown>;
          const msgHasAtt = hasAttachments(raw.bodyStructure);
          if (options.hasAttachment === msgHasAtt) {
            filteredUids.push(raw.uid as number);
          }
        }

        uids = filteredUids;
      }

      if (uids.length === 0) {
        return {
          items: [],
          total: 0,
          page,
          pageSize,
          hasMore: false,
        };
      }

      uids = await orderUidsByDate(
        client,
        uids,
        Math.max(page * pageSize * 3, DEFAULT_DATE_SORT_WINDOW),
      );
      const total = uids.length;
      const start = (page - 1) * pageSize;
      const pageUids = uids.slice(start, start + pageSize);

      if (pageUids.length === 0) {
        return {
          items: [],
          total,
          page,
          pageSize,
          hasMore: false,
        };
      }

      const items: EmailMeta[] = [];
      const range = pageUids.join(',');

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          source: { start: 0, maxLength: LIST_PREVIEW_SOURCE_MAX_BYTES },
        },
        { uid: true },
      )) {
        items.push(messageToEmailMeta(msg as unknown as Record<string, unknown>));
      }

      items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      return {
        items,
        total,
        page,
        pageSize,
        hasMore: start + pageSize < total,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  async listLabels(accountName: string): Promise<LabelInfo[]> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    return strategy.listLabels(client);
  }

  async addLabel(
    accountName: string,
    emailId: string,
    mailbox: string,
    label: string,
  ): Promise<void> {
    const uidText = parseMessageUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const cleanLabel = validateLabelName(label);
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.addLabel(client, uidText, safeMailbox, cleanLabel);
  }

  async removeLabel(
    accountName: string,
    emailId: string,
    mailbox: string,
    label: string,
  ): Promise<void> {
    const uidText = parseMessageUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const cleanLabel = validateLabelName(label);
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.removeLabel(client, uidText, safeMailbox, cleanLabel);
  }

  async createLabel(accountName: string, name: string): Promise<void> {
    const cleanName = validateLabelName(name);
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.createLabel(client, cleanName);
  }

  async deleteLabel(accountName: string, name: string): Promise<void> {
    const cleanName = validateLabelName(name);
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.deleteLabel(client, cleanName);
  }

  // -------------------------------------------------------------------------
  // Virtual-folder detection
  // -------------------------------------------------------------------------

  private static readonly VIRTUAL_SPECIAL_USE = new Set(['\\All', '\\Flagged']);

  private static async assertRealMailbox(client: ImapFlow, mailboxPath: string): Promise<void> {
    const mailboxes = await client.list();
    const mb = mailboxes.find((m) => m.path === mailboxPath);
    if (!mb) return; // unknown — let the server reject if invalid
    const virtualFlag = [...ImapService.VIRTUAL_SPECIAL_USE].find(
      (f) => mb.specialUse === f || mb.flags?.has(f),
    );
    if (virtualFlag) {
      throw new Error(
        `"${mailboxPath}" is a virtual folder (${virtualFlag}). ` +
          'Use find_email_folder to locate the real folder first.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Find real folder for an email
  // -------------------------------------------------------------------------

  async findEmailFolder(
    accountName: string,
    emailId: string,
    sourceMailbox: string,
  ): Promise<{ folders: string[]; messageId?: string }> {
    const uidText = parseMessageUid(emailId);
    const safeSource = sanitizeMailboxName(sourceMailbox);
    const client = await this.connections.getImapClient(accountName);

    // 1. Fetch Message-ID from the source mailbox
    let messageId: string | undefined;
    const srcLock = await lockMailbox(client, safeSource);
    try {
      const msg = await client.fetchOne(uidText, { headers: true }, { uid: true });
      // biome-ignore lint/complexity/useOptionalChain: optional chain breaks TS type narrowing for union with false
      if (msg && msg.headers && Buffer.isBuffer(msg.headers)) {
        const headerText = msg.headers.toString('utf-8');
        const match = /^message-id:\s*(.+)$/im.exec(headerText);
        if (match) {
          messageId = match[1].trim();
        }
      }
    } finally {
      srcLock.release();
    }

    if (!messageId) {
      throw new Error('Could not retrieve Message-ID for this email.');
    }

    // 2. List all real mailboxes (exclude virtual and non-selectable)
    const allMailboxes = await client.list();
    const realMailboxes = allMailboxes.filter((mb) => {
      if (!mb.listed) return false;
      if (mb.flags?.has('\\Noselect')) return false;
      const isVirtual = [...ImapService.VIRTUAL_SPECIAL_USE].some(
        (f) => mb.specialUse === f || mb.flags?.has(f),
      );
      if (isVirtual) return false;
      return true;
    });

    // 3. Search each real mailbox for the Message-ID (sequential — each needs its own lock)
    const folders: string[] = [];
    const searchMailbox = async (mbPath: string): Promise<void> => {
      try {
        const lock = await lockMailbox(client, mbPath);
        try {
          const results = await client.search(
            { header: { 'message-id': messageId } },
            { uid: true },
          );
          if (results && Array.isArray(results) && results.length > 0) {
            folders.push(mbPath);
          }
        } finally {
          lock.release();
        }
      } catch {
        // Skip folders that can't be selected or searched (e.g. \Noselect, INBOX on some providers)
      }
    };
    // eslint-disable-next-line no-restricted-syntax
    for (const mb of realMailboxes) {
      // eslint-disable-next-line no-await-in-loop
      await searchMailbox(mb.path);
    }

    return { folders, messageId };
  }

  // -------------------------------------------------------------------------
  // Move / Delete
  // -------------------------------------------------------------------------

  async moveEmail(
    accountName: string,
    emailId: string,
    sourceMailbox: string,
    destinationMailbox: string,
  ): Promise<void> {
    const uidText = parseMessageUid(emailId);
    const safeSource = sanitizeMailboxName(sourceMailbox);
    const safeDest = sanitizeMailboxName(destinationMailbox);
    const client = await this.connections.getImapClient(accountName);
    await ImapService.assertRealMailbox(client, safeSource);
    const lock = await lockMailbox(client, safeSource);
    try {
      const ok = await client.messageMove(uidText, safeDest, { uid: true });
      if (!ok) {
        throw new Error(`IMAP server rejected the move from "${safeSource}" to "${safeDest}".`);
      }
    } finally {
      lock.release();
    }
  }

  async deleteEmail(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
    permanent = false,
  ): Promise<void> {
    const uidText = parseMessageUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);

    if (permanent) {
      const lock = await lockMailbox(client, safeMailbox);
      try {
        const ok = await client.messageDelete(uidText, { uid: true });
        if (!ok) {
          throw new Error('IMAP server rejected the delete operation.');
        }
      } finally {
        lock.release();
      }
    } else {
      await ImapService.assertRealMailbox(client, safeMailbox);
      const mailboxes = await client.list();
      const trash = mailboxes.find((mb) => mb.specialUse === '\\Trash');
      const trashPath = trash?.path ?? 'Trash';

      const lock = await lockMailbox(client, safeMailbox);
      try {
        const ok = await client.messageMove(uidText, trashPath, { uid: true });
        if (!ok) {
          throw new Error('IMAP server rejected the move to Trash.');
        }
      } finally {
        lock.release();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Flag management
  // -------------------------------------------------------------------------

  async setFlags(
    accountName: string,
    emailId: string,
    mailbox: string,
    action: FlagAction,
  ): Promise<void> {
    const uidText = parseMessageUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const { flags, add } = flagChange[action];
    const client = await this.connections.getImapClient(accountName);
    const lock = await lockMailbox(client, safeMailbox);
    try {
      let ok: boolean;
      if (add) {
        ok = await client.messageFlagsAdd(uidText, flags, { uid: true });
      } else {
        ok = await client.messageFlagsRemove(uidText, flags, { uid: true });
      }
      if (!ok) {
        throw new Error(`IMAP server rejected the ${action} flag operation.`);
      }
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Bulk operations
  // -------------------------------------------------------------------------

  async bulkSetFlags(
    accountName: string,
    ids: number[],
    mailbox: string,
    action: 'mark_read' | 'mark_unread' | 'flag' | 'unflag',
  ): Promise<BulkResult> {
    const range = bulkUidSet(ids);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    const lock = await lockMailbox(client, safeMailbox);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };
    try {
      const flagMap: Record<string, { flags: string[]; add: boolean }> = {
        mark_read: { flags: ['\\Seen'], add: true },
        mark_unread: { flags: ['\\Seen'], add: false },
        flag: { flags: ['\\Flagged'], add: true },
        unflag: { flags: ['\\Flagged'], add: false },
      };
      const { flags, add } = flagMap[action];
      let ok: boolean;
      if (add) {
        ok = await client.messageFlagsAdd(range, flags, { uid: true });
      } else {
        ok = await client.messageFlagsRemove(range, flags, { uid: true });
      }
      if (ok) {
        result.succeeded = ids.length;
      } else {
        result.failed = ids.length;
        result.errors = ['IMAP server rejected the flag operation.'];
      }
    } catch (err) {
      result.failed = ids.length;
      result.errors = [err instanceof Error ? err.message : String(err)];
    } finally {
      lock.release();
    }
    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  async bulkMove(
    accountName: string,
    ids: number[],
    mailbox: string,
    destination: string,
  ): Promise<BulkResult> {
    const range = bulkUidSet(ids);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const safeDest = sanitizeMailboxName(destination);
    const client = await this.connections.getImapClient(accountName);
    await ImapService.assertRealMailbox(client, safeMailbox);
    const lock = await lockMailbox(client, safeMailbox);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };
    try {
      const ok = await client.messageMove(range, safeDest, { uid: true });
      if (ok) {
        result.succeeded = ids.length;
      } else {
        result.failed = ids.length;
        result.errors = ['IMAP server rejected the move operation.'];
      }
    } catch (err) {
      result.failed = ids.length;
      result.errors = [err instanceof Error ? err.message : String(err)];
    } finally {
      lock.release();
    }
    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  async bulkDelete(
    accountName: string,
    ids: number[],
    mailbox: string,
    permanent = false,
  ): Promise<BulkResult> {
    const range = bulkUidSet(ids);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };

    if (permanent) {
      const lock = await lockMailbox(client, safeMailbox);
      try {
        const ok = await client.messageDelete(range, { uid: true });
        if (ok) {
          result.succeeded = ids.length;
        } else {
          result.failed = ids.length;
          result.errors = ['IMAP server rejected the delete operation.'];
        }
      } catch (err) {
        result.failed = ids.length;
        result.errors = [err instanceof Error ? err.message : String(err)];
      } finally {
        lock.release();
      }
    } else {
      await ImapService.assertRealMailbox(client, safeMailbox);
      const mailboxes = await client.list();
      const trash = mailboxes.find((mb) => mb.specialUse === '\\Trash');
      const trashPath = trash?.path ?? 'Trash';

      const lock = await lockMailbox(client, safeMailbox);
      try {
        const ok = await client.messageMove(range, trashPath, { uid: true });
        if (ok) {
          result.succeeded = ids.length;
        } else {
          result.failed = ids.length;
          result.errors = ['IMAP server rejected the move to Trash.'];
        }
      } catch (err) {
        result.failed = ids.length;
        result.errors = [err instanceof Error ? err.message : String(err)];
      } finally {
        lock.release();
      }
    }

    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  // -------------------------------------------------------------------------
  // Draft management
  // -------------------------------------------------------------------------

  async saveDraft(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      inReplyTo?: string;
      attachments?: OutgoingAttachment[];
    },
  ): Promise<{ id: number; mailbox: string }> {
    const nodemailerAttachments = await resolveOutgoingAttachments(options.attachments);

    const client = await this.connections.getImapClient(accountName);
    const account = this.connections.getAccount(accountName);

    const mailboxes = await client.list();
    const drafts = mailboxes.find((mb) => mb.specialUse === '\\Drafts');
    const draftsPath = drafts?.path ?? 'Drafts';

    const rawMessage = await compileRfc822({
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      inReplyTo: options.inReplyTo,
      attachments: nodemailerAttachments,
      disableFileAccess: true,
      disableUrlAccess: true,
      ...(options.html ? { html: options.body } : { text: options.body }),
    });

    const appendResult = await client.append(draftsPath, rawMessage, ['\\Draft', '\\Seen']);

    return {
      id: (appendResult as unknown as { uid?: number }).uid ?? 0,
      mailbox: draftsPath,
    };
  }

  /**
   * Best-effort APPEND of a sent message to the \\Sent mailbox.
   */
  async appendSentMessage(accountName: string, raw: Buffer): Promise<void> {
    const client = await this.connections.getImapClient(accountName);
    let sentPath = this.connections.getAccount(accountName).sentMailbox;
    if (!sentPath) {
      const mailboxes = await client.list();
      sentPath = mailboxes.find((mb) => mb.specialUse === '\\Sent')?.path ?? 'Sent';
    }
    await client.append(sentPath, raw, ['\\Seen']);
  }

  async getEmailSecurity(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
  ): Promise<ReturnType<typeof parseSenderAuth> & { uid: string; mailbox: string }> {
    const uidText = parseMessageUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    const lock = await lockMailbox(client, safeMailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(
        uidText,
        { uid: true, envelope: true, headers: true },
        { uid: true },
      );
      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }
      const raw = msg as unknown as Record<string, unknown>;
      const headerBuf = raw.headers;
      const headerText = Buffer.isBuffer(headerBuf)
        ? headerBuf.toString('utf-8')
        : String(headerBuf ?? '');
      return { ...parseSenderAuth(headerText), uid: uidText, mailbox: safeMailbox };
    } finally {
      lock.release();
    }
  }

  /**
   * Headers-safe body peek for classification. Uses a readOnly lock and never
   * fetches `source: true` (which can set \\Seen).
   */
  async peekText(accountName: string, emailId: string, mailbox = 'INBOX'): Promise<string> {
    const uidText = parseMessageUid(emailId);
    const uid = Number(uidText);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    const lock = await lockMailbox(client, safeMailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(uidText, { uid: true, bodyStructure: true }, { uid: true });
      if (!msg) return '';
      const raw = msg as unknown as Record<string, unknown>;
      const parts = findTextMimeParts(raw.bodyStructure);
      let bodyText: string | undefined;
      let bodyHtml: string | undefined;
      if (parts.plain) bodyText = await downloadMimePart(client, uid, parts.plain);
      if (parts.html) bodyHtml = await downloadMimePart(client, uid, parts.html);
      return preferRicherPlain(bodyText, bodyHtml);
    } finally {
      lock.release();
    }
  }

  async peekAttachments(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
  ): Promise<{ filename: string; mime: string }[]> {
    const uidText = parseMessageUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    const lock = await lockMailbox(client, safeMailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(uidText, { uid: true, bodyStructure: true }, { uid: true });
      if (!msg) return [];
      const raw = msg as unknown as Record<string, unknown>;
      return extractAttachments(raw.bodyStructure).map((a) => ({
        filename: a.filename,
        mime: a.mimeType,
      }));
    } finally {
      lock.release();
    }
  }

  /**
   * Fetch a draft message for sending.
   * Returns the parsed draft with recipients and content.
   */
  async fetchDraft(
    accountName: string,
    emailId: number,
    mailbox?: string,
  ): Promise<{
    email: Email;
    mailbox: string;
  }> {
    const uidText = parseMessageUid(String(emailId));
    const requestedMailbox = mailbox === undefined ? undefined : sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);

    // Find drafts folder if not specified
    let draftsPath = requestedMailbox;
    if (!draftsPath) {
      const mailboxes = await client.list();
      const draftsFolder = mailboxes.find((mb) => mb.specialUse === '\\Drafts');
      draftsPath = draftsFolder?.path ?? 'Drafts';
    }

    const email = await this.getEmail(accountName, uidText, draftsPath);
    return { email, mailbox: draftsPath };
  }

  /** Delete a draft after it has been sent. */
  async deleteDraft(accountName: string, emailId: number, mailbox: string): Promise<void> {
    const uidText = parseMessageUid(String(emailId));
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    const lock = await lockMailbox(client, safeMailbox);
    try {
      await client.messageDelete(uidText, { uid: true });
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Mailbox (folder) CRUD
  // -------------------------------------------------------------------------

  async createMailbox(accountName: string, folderPath: string): Promise<void> {
    const safePath = sanitizeMailboxName(folderPath);
    const client = await this.connections.getImapClient(accountName);
    await client.mailboxCreate(safePath);
  }

  async renameMailbox(accountName: string, folderPath: string, newPath: string): Promise<void> {
    const safePath = sanitizeMailboxName(folderPath);
    const safeNewPath = sanitizeMailboxName(newPath);
    const client = await this.connections.getImapClient(accountName);
    await assertMailboxRemovable(client, safePath, 'rename');
    await client.mailboxRename(safePath, safeNewPath);
  }

  async deleteMailbox(accountName: string, folderPath: string): Promise<void> {
    const safePath = sanitizeMailboxName(folderPath);
    const client = await this.connections.getImapClient(accountName);
    await assertMailboxRemovable(client, safePath, 'delete');
    await client.mailboxDelete(safePath);
  }

  // -------------------------------------------------------------------------
  // Attachment download
  // -------------------------------------------------------------------------

  async downloadAttachment(
    accountName: string,
    emailId: string,
    mailbox: string,
    filename: string,
    maxSizeBytes = 5 * 1024 * 1024,
  ): Promise<{
    filename: string;
    mimeType: string;
    size: number;
    contentBase64: string;
  }> {
    const uidText = parseMessageUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);

    const lock = await lockMailbox(client, safeMailbox);
    try {
      // Fetch bodyStructure to find the MIME part
      const msg = await client.fetchOne(uidText, { uid: true, bodyStructure: true }, { uid: true });

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      const attachments = listAttachmentParts(msg.bodyStructure);
      const matches = attachments.filter((a) => a.filename === filename);
      if (matches.length === 0) {
        throw new Error(
          `Attachment "${filename}" not found. Available: ${attachments.map((a) => a.filename).join(', ') || 'none'}`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `Attachment name "${filename}" matches ${matches.length} attachments in email ${uidText} (MIME parts ${matches.map((a) => a.part).join(', ')}); refusing to guess which one to return.`,
        );
      }
      const [attachment] = matches;

      if (attachment.size > maxSizeBytes) {
        throw new Error(
          `Attachment "${filename}" is ${Math.round(attachment.size / 1024 / 1024)}MB, exceeds ${Math.round(maxSizeBytes / 1024 / 1024)}MB limit`,
        );
      }

      if (!attachment.part) {
        throw new Error(`Could not locate MIME part for "${filename}"`);
      }

      const content = await downloadPart(client, uidText, attachment.part);
      if (!content) {
        throw new Error(`Failed to download attachment "${filename}"`);
      }

      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: content.length,
        contentBase64: content.toString('base64'),
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Raw RFC 822 export
  // -------------------------------------------------------------------------

  /**
   * Return the message octets exactly as the server stores them (BODY.PEEK[]).
   * The readOnly lock opens the mailbox with EXAMINE, so a server that ignores
   * PEEK still cannot set \\Seen or change any other flag.
   */
  async exportEmail(
    accountName: string,
    emailId: string,
    mailbox: string,
    maxSizeBytes: number,
  ): Promise<{
    filename: string;
    mimeType: string;
    size: number;
    source: Buffer;
  }> {
    const uidText = parseMessageUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);

    const lock = await lockMailbox(client, safeMailbox, { readOnly: true });
    try {
      const meta = await client.fetchOne(
        uidText,
        { uid: true, size: true, internalDate: true },
        { uid: true },
      );
      if (!meta) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }
      // Checked before the source fetch so an oversized message is never transferred.
      if (typeof meta.size === 'number' && meta.size > maxSizeBytes) {
        throw exportTooLarge(uidText, meta.size, maxSizeBytes);
      }

      const msg = await client.fetchOne(uidText, { uid: true, source: true }, { uid: true });
      if (!msg || !Buffer.isBuffer(msg.source)) {
        throw new Error(`Could not fetch the source of email ${emailId} in ${mailbox}`);
      }
      // RFC822.SIZE is the server's claim; the octets it sent are what would be written.
      if (msg.source.length > maxSizeBytes) {
        throw exportTooLarge(uidText, msg.source.length, maxSizeBytes);
      }

      return {
        filename: emlFilename(meta.internalDate, uidText),
        mimeType: 'message/rfc822',
        size: msg.source.length,
        source: msg.source,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Save all email attachments to a local directory
  // -------------------------------------------------------------------------

  /**
   * Download and save all non-ICS attachments from an email to a local directory.
   * Returns metadata including the saved file paths and file:// URLs.
   *
   * Attachments larger than maxSizeBytes are skipped.
   */
  async saveEmailAttachments(
    accountName: string,
    emailId: string,
    mailbox: string,
    destDir: string,
    maxSizeBytes = SAVED_ATTACHMENT_MAX_BYTES,
  ): Promise<SavedAttachment[]> {
    const uidText = parseMessageUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    const lock = await lockMailbox(client, safeMailbox);
    try {
      const msg = await client.fetchOne(uidText, { uid: true, bodyStructure: true }, { uid: true });
      if (!msg) return [];
      // biome-ignore format: line too long; eslint implicit-arrow-linebreak prevents multi-line implicit return
      const parts = listAttachmentParts(msg.bodyStructure).filter((a) => a.size <= maxSizeBytes && !a.mimeType.includes('calendar') && !a.filename.toLowerCase().endsWith('.ics'));
      if (parts.length === 0) return [];
      return await writeAttachmentParts(client, uidText, parts, destDir);
    } finally {
      lock.release();
    }
  }

  /**
   * Reconstruct an email thread by following References / In-Reply-To chains.
   * Searches by Message-ID header for each reference and returns messages in
   * chronological order. Caps at MAX_THREAD_MESSAGES to prevent runaway chains.
   */
  async getThread(
    accountName: string,
    messageId: string,
    mailbox = 'INBOX',
  ): Promise<{
    threadId: string;
    messages: Email[];
    participants: EmailAddress[];
    messageCount: number;
  }> {
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    const lock = await lockMailbox(client, safeMailbox);
    try {
      const uidList = await findThreadUids(client, messageId, MAX_THREAD_MESSAGES);
      if (uidList.length === 0) {
        return {
          threadId: messageId,
          messages: [],
          participants: [],
          messageCount: 0,
        };
      }

      // Fetch full content for all thread messages
      const range = uidList.join(',');
      const messages: Email[] = [];

      // imapflow runs one command at a time and a FETCH stays in flight until
      // its loop ends, so the body downloads in messageToEmail must start after it.
      const rows = await client.fetchAll(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          headers: MESSAGE_HEADER_FIELDS,
        },
        { uid: true },
      );
      // eslint-disable-next-line no-restricted-syntax
      for (const msg of rows) {
        const raw = msg as unknown as Record<string, unknown>;
        // eslint-disable-next-line no-await-in-loop
        messages.push(await messageToEmail(raw, client, raw.uid as number));
      }

      // Sort chronologically
      messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // Extract unique participants
      const participantMap = new Map<string, EmailAddress>();
      messages.forEach((email) => {
        const addParticipant = (addr: EmailAddress) => {
          const key = addr.address.toLowerCase();
          if (!participantMap.has(key)) {
            participantMap.set(key, addr);
          }
        };
        addParticipant(email.from);
        email.to.forEach(addParticipant);
        email.cc?.forEach(addParticipant);
      });

      return {
        threadId: messageId,
        messages,
        participants: Array.from(participantMap.values()),
        messageCount: messages.length,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Contact extraction
  // -------------------------------------------------------------------------

  async extractContacts(
    accountName: string,
    options: { mailbox?: string; limit?: number } = {},
  ): Promise<Contact[]> {
    const mailbox = sanitizeMailboxName(options.mailbox ?? 'INBOX');
    const client = await this.connections.getImapClient(accountName);
    const limit = Math.min(options.limit ?? 100, 500);

    const lock = await lockMailbox(client, mailbox);
    try {
      // Search for all messages, take the latest N
      const searchResult = await client.search({ all: true }, { uid: true });
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      if (uids.length === 0) return [];

      uids.sort((a, b) => b - a);
      const targetUids = uids.slice(0, limit);
      const range = targetUids.join(',');

      const contactMap = new Map<
        string,
        { name?: string; email: string; frequency: number; lastSeen: Date }
      >();

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(range, { uid: true, envelope: true }, { uid: true })) {
        const envelope = ((msg as unknown as Record<string, unknown>).envelope ?? {}) as Record<
          string,
          unknown
        >;
        const date = envelope.date ? new Date(envelope.date as string) : new Date();

        const addressLists = [
          envelope.from as { name?: string; address?: string }[] | undefined,
          envelope.to as { name?: string; address?: string }[] | undefined,
          envelope.cc as { name?: string; address?: string }[] | undefined,
        ];

        addressLists.forEach((addrs) => {
          (addrs ?? []).forEach((addr) => {
            if (!addr.address) return;
            const key = addr.address.toLowerCase();
            const existing = contactMap.get(key);
            if (existing) {
              existing.frequency += 1;
              if (date > existing.lastSeen) {
                existing.lastSeen = date;
                if (addr.name) existing.name = addr.name;
              }
            } else {
              contactMap.set(key, {
                name: addr.name ?? undefined,
                email: addr.address,
                frequency: 1,
                lastSeen: date,
              });
            }
          });
        });
      }

      // Sort by frequency descending
      const contacts: Contact[] = Array.from(contactMap.values())
        .sort((a, b) => b.frequency - a.frequency)
        .map((c) => ({
          name: c.name,
          email: c.email,
          frequency: c.frequency,
          lastSeen: c.lastSeen.toISOString(),
        }));

      return contacts;
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Email analytics
  // -------------------------------------------------------------------------

  async getEmailStats(
    accountName: string,
    mailbox: string,
    period: 'day' | 'week' | 'month',
  ): Promise<EmailStats> {
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);

    const now = new Date();
    const since = new Date(now);
    if (period === 'day') since.setDate(since.getDate() - 1);
    else if (period === 'week') since.setDate(since.getDate() - 7);
    else since.setMonth(since.getMonth() - 1);

    const lock = await lockMailbox(client, safeMailbox);
    try {
      // Date-range search
      const uids: number[] = await client
        .search({ since }, { uid: true })
        .then((r: unknown) => (Array.isArray(r) ? r : []) as number[]);

      if (uids.length === 0) {
        return {
          period,
          dateRange: {
            from: since.toISOString().split('T')[0],
            to: now.toISOString().split('T')[0],
          },
          totalReceived: 0,
          unreadCount: 0,
          flaggedCount: 0,
          topSenders: [],
          dailyVolume: [],
          hasAttachmentsCount: 0,
          avgPerDay: 0,
        };
      }

      const range = uids.join(',');
      const senderMap = new Map<string, { email: string; name?: string; count: number }>();
      const dailyMap = new Map<string, number>();
      let unread = 0;
      let flagged = 0;
      let withAttachments = 0;

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        },
        { uid: true },
      )) {
        const envelope = ((msg as unknown as Record<string, unknown>).envelope ?? {}) as Record<
          string,
          unknown
        >;
        const flags = ((msg as unknown as Record<string, unknown>).flags ??
          new Set()) as Set<string>;
        const { bodyStructure } = msg as unknown as Record<string, unknown>;

        // Count flags
        if (!flags.has('\\Seen')) unread += 1;
        if (flags.has('\\Flagged')) flagged += 1;
        if (hasAttachments(bodyStructure)) withAttachments += 1;

        // Track sender
        const fromList = (envelope.from ?? []) as {
          name?: string;
          address?: string;
        }[];
        if (fromList.length > 0 && fromList[0].address) {
          const key = fromList[0].address.toLowerCase();
          const existing = senderMap.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            senderMap.set(key, {
              email: fromList[0].address,
              name: fromList[0].name,
              count: 1,
            });
          }
        }

        // Track daily volume
        const date = envelope.date ? new Date(envelope.date as string) : new Date();
        const dayKey = date.toISOString().split('T')[0];
        dailyMap.set(dayKey, (dailyMap.get(dayKey) ?? 0) + 1);
      }

      const topSenders: SenderStat[] = Array.from(senderMap.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const dailyVolume: DailyVolume[] = Array.from(dailyMap.entries())
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const days = Math.max(1, dailyVolume.length);

      return {
        period,
        dateRange: {
          from: since.toISOString().split('T')[0],
          to: now.toISOString().split('T')[0],
        },
        totalReceived: uids.length,
        unreadCount: unread,
        flaggedCount: flagged,
        topSenders,
        dailyVolume,
        hasAttachmentsCount: withAttachments,
        avgPerDay: Math.round((uids.length / days) * 10) / 10,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------

  async getQuota(accountName: string): Promise<QuotaInfo | null> {
    const client = await this.connections.getImapClient(accountName);
    try {
      const quota = await client.getQuota('INBOX');
      // imapflow reports bytes in storage.usage; its type declaration names the field `used`.
      const storage = quota
        ? (quota.storage as { usage?: number; limit?: number } | undefined)
        : undefined;
      if (!storage?.limit) return null;

      const usedMb = Math.round((storage.usage ?? 0) / 1024 / 1024);
      const totalMb = Math.round(storage.limit / 1024 / 1024);
      return {
        usedMb,
        totalMb,
        percentage: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0,
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  async getCapabilities(accountName: string): Promise<string[]> {
    const client = await this.connections.getImapClient(accountName);
    // imapflow maps each capability name to true, or to a number such as APPENDLIMIT's.
    return [...client.capabilities.keys()];
  }

  // -------------------------------------------------------------------------
  // Calendar part extraction
  // -------------------------------------------------------------------------

  /* eslint-disable no-await-in-loop, no-restricted-syntax -- Sequential IMAP fetch required */
  async getCalendarParts(accountName: string, mailbox: string, emailId: string): Promise<string[]> {
    const uidText = parseMessageUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    const lock = await lockMailbox(client, safeMailbox);

    try {
      const icsContents: string[] = [];

      const msg = await client.fetchOne(uidText, { uid: true, bodyStructure: true }, { uid: true });
      if (!msg) return icsContents;

      // imapflow runs one command at a time, so each part is downloaded only
      // after the structure fetch has finished. A part fetched inside an open
      // FETCH loop never starts.
      for (const partId of this.findCalendarParts(msg.bodyStructure)) {
        const content = await downloadPart(client, uidText, partId);
        if (content) icsContents.push(content.toString('utf-8'));
      }

      return icsContents;
    } finally {
      lock.release();
    }
  }
  /* eslint-enable no-await-in-loop, no-restricted-syntax */

  /**
   * Recursively find body parts with text/calendar content type.
   */
  private findCalendarParts(structure: unknown, prefix = ''): string[] {
    if (!structure || typeof structure !== 'object') return [];
    const s = structure as Record<string, unknown>;
    const parts: string[] = [];

    const disposition = (s.disposition as string | undefined)?.toLowerCase() ?? '';
    const params = partParameters(s);
    const isIcsAttachment =
      disposition === 'attachment' &&
      (params.filename ?? params.name ?? '').toLowerCase().endsWith('.ics');

    // imapflow reports the type as "text/calendar" with no subtype field.
    if (mimeTypeOf(s) === 'text/calendar' || isIcsAttachment) {
      // A single-part message has no part number from imapflow; its body is part 1.
      parts.push((s.part as string | undefined) ?? (prefix || '1'));
    }

    // Recurse into child nodes
    if (Array.isArray(s.childNodes)) {
      s.childNodes.forEach((child: unknown, i: number) => {
        const childPrefix = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
        parts.push(...this.findCalendarParts(child, childPrefix));
      });
    }

    return parts;
  }
}
