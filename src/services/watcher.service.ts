/**
 * IMAP IDLE Watcher — real-time email monitoring.
 *
 * Maintains dedicated IMAP connections per account using IDLE to detect
 * new emails in real-time. Emits events on the shared event bus.
 *
 * Key design decisions:
 * - Separate ImapFlow connections from ConnectionManager (an idling connection serves no tools)
 * - Auto-reconnect with exponential backoff on connection failures
 * - Tracks last-seen UID per folder to detect genuinely new messages
 */

import type { MailboxLockObject } from 'imapflow';
import { ImapFlow } from 'imapflow';
import { buildImapAuth } from '../connections/auth.js';
import { bindImapLifecycle, buildImapFlowOptions } from '../connections/manager.js';
import type { AccessTokenSource } from '../connections/types.js';
import { mcpLog } from '../logging.js';
import type { AccountConfig, EmailMeta, WatcherConfig } from '../types/index.js';
import type { EmailEventBus } from './event-bus.js';
import eventBus from './event-bus.js';
import OAuthService from './oauth.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IdleState {
  client: ImapFlow | null;
  account: AccountConfig;
  folder: string;
  lastSeenUid: number;
  /** UIDVALIDITY of the last select; null until the first one succeeds. */
  uidValidity: bigint | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  stopped: boolean;
}

export interface WatcherStatus {
  account: string;
  folder: string;
  connected: boolean;
  lastSeenUid: number;
}

// ---------------------------------------------------------------------------
// System flags excluded from label extraction
// ---------------------------------------------------------------------------

const SYSTEM_FLAGS = new Set([
  '\\Seen',
  '\\Answered',
  '\\Flagged',
  '\\Deleted',
  '\\Draft',
  '\\Recent',
  '\\*',
]);

export interface WatcherFetchMessage {
  uid: number;
  flags?: Set<string>;
  envelope?: {
    subject?: string;
    from?: { name?: string; address?: string }[];
    to?: { name?: string; address?: string }[];
    date?: Date;
    messageId?: string;
  };
  bodyStructure?: unknown;
}

function structureHasAttachments(bodyStructure: unknown): boolean {
  if (!bodyStructure || typeof bodyStructure !== 'object') return false;
  const bs = bodyStructure as { disposition?: string; childNodes?: unknown[] };
  if (bs.disposition === 'attachment') return true;
  return bs.childNodes?.some((child) => structureHasAttachments(child)) ?? false;
}

export function buildEmailMeta(msg: WatcherFetchMessage): EmailMeta {
  const flags = msg.flags ?? new Set<string>();
  const labels = [...flags].filter((f) => !SYSTEM_FLAGS.has(f));

  const from = msg.envelope?.from?.[0];
  const to = msg.envelope?.to ?? [];

  return {
    id: String(msg.uid),
    subject: msg.envelope?.subject ?? '(no subject)',
    from: { name: from?.name, address: from?.address ?? '' },
    to: to.map((a) => ({ name: a.name, address: a.address ?? '' })),
    date: msg.envelope?.date?.toISOString() ?? new Date().toISOString(),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: structureHasAttachments(msg.bodyStructure),
    labels,
    messageId: msg.envelope?.messageId,
  };
}

// ---------------------------------------------------------------------------
// WatcherService
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;

/**
 * These connections only idle, so imapflow's 15 s default would just hold back the notice for
 * mail that lands right after a fetch.
 */
const AUTO_IDLE_DELAY_MS = 1_000;

function closeQuietly(client: ImapFlow): void {
  try {
    client.close();
  } catch {
    /* already closed */
  }
}

export default class WatcherService {
  private idleStates = new Map<string, IdleState>();

  private config: WatcherConfig;

  private accounts: AccountConfig[];

  constructor(
    config: WatcherConfig,
    accounts: AccountConfig[],
    private readonly events: EmailEventBus = eventBus,
    private readonly tokens: AccessTokenSource = new OAuthService(),
  ) {
    this.config = config;
    this.accounts = accounts;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return;

    const { folders } = this.config;
    const startOps: Promise<void>[] = [];
    this.accounts.forEach((account) => {
      folders.forEach((folder) => {
        startOps.push(this.startIdle(account, folder));
      });
    });
    await Promise.allSettled(startOps);
  }

  async stop(): Promise<void> {
    const stopOps = [...this.idleStates.values()].map(async (state) => {
      this.updateState(WatcherService.stateKey(state), { stopped: true });
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      const { client } = state;
      try {
        if (client?.usable) await client.logout();
        // Still logging in: close the socket instead of waiting for a session to log out of.
        else if (client) closeQuietly(client);
      } catch {
        /* ignore */
      }
    });
    await Promise.allSettled(stopOps);
    this.idleStates.clear();
  }

  getStatus(): WatcherStatus[] {
    return [...this.idleStates.values()].map((state) => ({
      account: state.account.name,
      folder: state.folder,
      connected: state.client?.usable === true,
      lastSeenUid: state.lastSeenUid,
    }));
  }

  // -------------------------------------------------------------------------
  // State helpers (avoid param reassignment)
  // -------------------------------------------------------------------------

  private static stateKey(state: IdleState): string {
    return `${state.account.name}:${state.folder}`;
  }

  private updateState(key: string, updates: Partial<IdleState>): void {
    const state = this.idleStates.get(key);
    if (state) Object.assign(state, updates);
  }

  private forgetClient(key: string, client: ImapFlow): void {
    if (this.idleStates.get(key)?.client !== client) return;
    this.updateState(key, { client: null });
    this.scheduleReconnect(key);
  }

  // -------------------------------------------------------------------------
  // IDLE connection lifecycle
  // -------------------------------------------------------------------------

  private async startIdle(account: AccountConfig, folder: string): Promise<void> {
    const key = `${account.name}:${folder}`;
    this.idleStates.set(key, {
      client: null,
      account,
      folder,
      lastSeenUid: 0,
      uidValidity: null,
      reconnectTimer: null,
      backoffMs: INITIAL_BACKOFF_MS,
      stopped: false,
    });
    await this.connectIdle(key);
  }

  private async connectIdle(key: string): Promise<void> {
    const state = this.idleStates.get(key);
    if (!state || state.stopped) return;

    let client: ImapFlow | undefined;
    try {
      const auth = await buildImapAuth(state.account, this.tokens);
      // stop() cannot close a client that does not exist yet.
      if (state.stopped) return;

      client = new ImapFlow({
        ...buildImapFlowOptions(state.account, {
          maxIdleTime: this.config.idleTimeout * 1000,
          autoIdleDelay: AUTO_IDLE_DELAY_MS,
        }),
        auth,
      });
      const current = client;
      this.updateState(key, { client: current });
      // Bound before connect: an 'error' event with no listener throws and ends the process.
      bindImapLifecycle(state.account.name, current, () => {
        this.forgetClient(key, current);
      });
      current.on('exists', (data: { path: string; count: number; prevCount: number }) => {
        if (data.count > data.prevCount) {
          this.handleNewEmails(key).catch(() => {});
        }
      });

      await current.connect();

      // Opened without a lock: imapflow starts IDLE only on a connection no lock is held on.
      const { uidNext, uidValidity } = await current.mailboxOpen(state.folder);
      // A reconnect carries on after the last UID it reported, unless the server renumbered.
      const resumeAfter = state.uidValidity === uidValidity ? state.lastSeenUid : uidNext - 1;

      this.updateState(key, {
        lastSeenUid: resumeAfter,
        uidValidity,
        backoffMs: INITIAL_BACKOFF_MS,
      });

      await mcpLog(
        'info',
        'watcher',
        `IDLE started: ${state.account.name}/${state.folder} (uid > ${resumeAfter})`,
      );

      // Mail delivered while the connection was down raises no EXISTS on the new one.
      if (uidNext - 1 > resumeAfter) {
        this.handleNewEmails(key).catch(() => {});
      }
    } catch (err) {
      // imapflow leaves the socket open when LOGIN or SELECT is refused.
      if (client) closeQuietly(client);
      const errMsg = err instanceof Error ? err.message : String(err);
      await mcpLog(
        'warning',
        'watcher',
        `IDLE connect failed for ${state.account.name}/${state.folder}: ${errMsg}`,
      );
      this.scheduleReconnect(key);
    }
  }

  private scheduleReconnect(key: string): void {
    const state = this.idleStates.get(key);
    // Both the close event and the failed connect ask; one pending attempt is enough.
    if (!state || state.stopped || state.reconnectTimer) return;

    const { backoffMs } = state;
    mcpLog(
      'info',
      'watcher',
      `Reconnecting ${state.account.name}/${state.folder} in ${backoffMs}ms`,
    ).catch(() => {});

    const timer = setTimeout(() => {
      this.updateState(key, {
        reconnectTimer: null,
        backoffMs: Math.min(backoffMs * 2, MAX_BACKOFF_MS),
      });
      this.connectIdle(key).catch(() => {});
    }, backoffMs);
    timer.unref();

    this.updateState(key, { reconnectTimer: timer });
  }

  // -------------------------------------------------------------------------
  // New email detection
  // -------------------------------------------------------------------------

  private async handleNewEmails(key: string): Promise<void> {
    const state = this.idleStates.get(key);
    const client = state?.client;
    if (!state || !client) return;

    let lock: MailboxLockObject | undefined;
    try {
      // Held only for the fetch, so IDLE resumes once it is released.
      lock = await client.getMailboxLock(state.folder);
      const searchRange = `${state.lastSeenUid + 1}:*`;
      const emails: EmailMeta[] = [];
      let maxUid = state.lastSeenUid;

      // eslint-disable-next-line no-restricted-syntax -- need sequential async iteration
      for await (const msg of client.fetch(
        searchRange,
        { uid: true, envelope: true, flags: true, bodyStructure: true },
        // Without it imapflow reads the range as sequence numbers, which trail UIDs after deletes.
        { uid: true },
      )) {
        // `N:*` still matches the newest message when no UID reaches N.
        if (msg.uid > state.lastSeenUid) {
          emails.push(buildEmailMeta(msg));
          maxUid = Math.max(maxUid, msg.uid);
        }
      }

      if (maxUid > state.lastSeenUid) {
        this.updateState(key, { lastSeenUid: maxUid });
      }

      if (emails.length > 0) {
        this.events.emit('email:new', {
          account: state.account.name,
          mailbox: state.folder,
          emails,
        });

        await mcpLog(
          'info',
          'watcher',
          `📬 ${emails.length} new email(s) in ${state.account.name}/${state.folder}`,
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await mcpLog('warning', 'watcher', `Failed to fetch new emails: ${errMsg}`);
    } finally {
      lock?.release();
    }
  }
}
