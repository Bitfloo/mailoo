/**
 * Connection manager for lazy-persistent IMAP and SMTP connections.
 *
 * - Creates connections on first use per account
 * - Reuses open connections across tool calls
 * - Auto-reconnects on failure
 * - Graceful shutdown closes all connections
 */

import { ImapFlow } from 'imapflow';
import type { SMTPPoolOptions, Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';
import { mcpLog } from '../logging.js';

import type { AccountConfig } from '../types/index.js';
import type { SmtpAuth } from './auth.js';
import { buildImapAuth, buildSmtpAuth } from './auth.js';
import { ConnectBackoff } from './backoff.js';
import type { AccessTokenSource, IConnectionManager } from './types.js';

function certificatesRequired(verifySsl: boolean | undefined): boolean {
  return verifySsl !== false;
}

export function buildImapFlowOptions(
  account: AccountConfig,
  extra: Record<string, unknown> = {},
): ConstructorParameters<typeof ImapFlow>[0] {
  const verifyCertificates = certificatesRequired(account.imap.verifySsl);
  if (!verifyCertificates && (account.imap.tls || account.imap.starttls)) {
    mcpLog(
      'warning',
      'imap',
      `IMAP certificate verification is disabled for "${account.name}"`,
    ).catch(() => {});
  }
  const { tls: extraTls, ...rest } = extra;
  const tlsExtras =
    extraTls !== null && typeof extraTls === 'object' ? (extraTls as Record<string, unknown>) : {};
  return {
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.tls,
    // Implicit TLS must omit doSTARTTLS (imapflow rejects secure together with doSTARTTLS);
    // with both false it stays unset because false would drop the opportunistic upgrade.
    ...(!account.imap.tls && account.imap.starttls ? { doSTARTTLS: true } : {}),
    logger: false,
    ...(account.imap.disableImap4rev2 ? { disableIMAP4rev2: true } : {}),
    ...rest,
    tls: {
      ...tlsExtras,
      rejectUnauthorized: verifyCertificates,
    },
  };
}

export function buildSmtpTransportOptions(account: AccountConfig, auth: SmtpAuth): SMTPPoolOptions {
  const pool = account.smtp.pool ?? {
    enabled: true,
    maxConnections: 1,
    maxMessages: 100,
  };

  return {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.tls,
    requireTLS: account.smtp.starttls,
    ignoreTLS: !account.smtp.tls && !account.smtp.starttls,
    tls: {
      rejectUnauthorized: account.smtp.verifySsl,
    },
    auth,
    pool: pool.enabled,
    ...(pool.enabled
      ? {
          maxConnections: pool.maxConnections,
          maxMessages: pool.maxMessages,
        }
      : {}),
  };
}

function describeAccounts(accounts: AccountConfig[]): string {
  return accounts.map((a) => `${a.name} (${a.email})`).join(', ');
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function bindImapLifecycle(
  accountName: string,
  client: ImapFlow,
  forgetIfCurrent: () => void,
): void {
  client.on('error', (err: Error) => {
    mcpLog(
      'warning',
      'imap',
      `ImapFlow error for "${accountName}": ${err instanceof Error ? err.message : String(err)}`,
    ).catch(() => {});
    forgetIfCurrent();
    try {
      client.close();
    } catch {
      /* ignore */
    }
  });
  client.on('close', forgetIfCurrent);
}

export default class ConnectionManager implements IConnectionManager {
  private imapClients = new Map<string, ImapFlow>();

  // Concurrent first calls (get_emails fans out 20 getEmail calls) must share one connect,
  // or every loser stays logged in outside the map and closeAll never reaches it.
  private imapConnecting = new Map<string, Promise<ImapFlow>>();

  private smtpTransports = new Map<string, Transporter>();

  private smtpConnecting = new Map<string, Promise<Transporter>>();

  private accounts = new Map<string, AccountConfig>();

  private backoff = new ConnectBackoff();

  private oauthService?: AccessTokenSource;

  private defaultAccount?: string;

  constructor(
    accounts: AccountConfig[],
    oauthService?: AccessTokenSource,
    defaultAccount?: string,
  ) {
    accounts.forEach((account) => {
      this.accounts.set(account.name, account);
    });
    this.oauthService = oauthService;
    this.defaultAccount = defaultAccount;
  }

  // -------------------------------------------------------------------------
  // Account lookup
  // -------------------------------------------------------------------------

  private findAccountByKey(key: string): AccountConfig | undefined {
    const exact = this.accounts.get(key);
    if (exact) return exact;
    const lower = key.toLowerCase();
    const values = [...this.accounts.values()];
    const byName = values.filter((account) => account.name.toLowerCase() === lower);
    const matches =
      byName.length > 0
        ? byName
        : values.filter((account) => account.email.toLowerCase() === lower);
    if (matches.length > 1) {
      throw new Error(
        `Account "${key}" matches more than one account: ${describeAccounts(matches)}. Pass the account name.`,
      );
    }
    return matches[0];
  }

  private formatAvailableAccounts(): string {
    if (this.accounts.size === 0) return 'none';
    return describeAccounts([...this.accounts.values()]);
  }

  getAccount(name?: string): AccountConfig {
    const trimmed = name?.trim() ?? '';
    if (trimmed.length > 0) {
      const direct = this.findAccountByKey(trimmed);
      if (direct) return direct;
      if (trimmed.toLowerCase() !== 'default') {
        throw new Error(
          `Account "${trimmed}" not found. Available accounts: ${this.formatAvailableAccounts()}`,
        );
      }
    }

    const configuredDefault = this.defaultAccount?.trim();
    if (configuredDefault) {
      const fromDefault = this.findAccountByKey(configuredDefault);
      if (fromDefault) return fromDefault;
      throw new Error(
        `Configured default account not found. Available accounts: ${this.formatAvailableAccounts()}`,
      );
    }

    if (this.accounts.size === 1) {
      const [onlyAccount] = this.accounts.values();
      if (onlyAccount) return onlyAccount;
    }

    throw new Error(
      `Account "${trimmed}" not found. Available accounts: ${this.formatAvailableAccounts()}`,
    );
  }

  resolveAccountName(name?: string): string {
    return this.getAccount(name).name;
  }

  getAccountNames(): string[] {
    return [...this.accounts.keys()];
  }

  // -------------------------------------------------------------------------
  // IMAP
  // -------------------------------------------------------------------------

  async getImapClient(accountName?: string): Promise<ImapFlow> {
    const account = this.getAccount(accountName);
    const resolvedName = account.name;
    const existing = this.imapClients.get(resolvedName);
    if (existing?.usable) {
      return existing;
    }

    // Clean up stale connection
    if (existing) {
      this.imapClients.delete(resolvedName);
      try {
        existing.close();
      } catch {
        /* ignore */
      }
    }

    const inFlight = this.imapConnecting.get(resolvedName);
    if (inFlight) return inFlight;

    const attempt = this.connectImap(account).finally(() => {
      this.imapConnecting.delete(resolvedName);
    });
    this.imapConnecting.set(resolvedName, attempt);
    return attempt;
  }

  private async connectImap(account: AccountConfig): Promise<ImapFlow> {
    const resolvedName = account.name;
    this.backoff.assertReady('IMAP', resolvedName);

    let client: ImapFlow | undefined;
    try {
      const auth = await buildImapAuth(account, this.oauthService);
      const connecting = new ImapFlow({
        ...buildImapFlowOptions(account),
        auth,
      });
      client = connecting;
      bindImapLifecycle(resolvedName, connecting, () => {
        if (this.imapClients.get(resolvedName) === connecting) {
          this.imapClients.delete(resolvedName);
        }
      });
      await connecting.connect();
    } catch (err) {
      this.backoff.recordFailure('IMAP', resolvedName, asError(err));
      // imapflow leaves the socket open when the server rejects LOGIN.
      try {
        client?.close();
      } catch {
        /* ignore */
      }
      throw err;
    }
    this.backoff.recordSuccess('IMAP', resolvedName);
    await mcpLog(
      'info',
      'imap',
      `Connected to ${account.imap.host}:${account.imap.port} for "${resolvedName}"`,
    );
    this.imapClients.set(resolvedName, client);
    return client;
  }

  // -------------------------------------------------------------------------
  // SMTP
  // -------------------------------------------------------------------------

  async getSmtpTransport(
    accountName?: string,
    options?: { verify?: boolean },
  ): Promise<Transporter> {
    const account = this.getAccount(accountName);
    const resolvedName = account.name;
    const verify = options?.verify ?? false;
    const existing = this.smtpTransports.get(resolvedName);
    if (existing) {
      if (!verify) {
        return existing;
      }
      try {
        await existing.verify();
        return existing;
      } catch {
        const current = this.smtpTransports.get(resolvedName);
        if (current === existing) {
          this.smtpTransports.delete(resolvedName);
        }
        try {
          existing.close();
        } catch {
          /* ignore */
        }
        // A concurrent caller already cached a verified replacement; a third connect would
        // overwrite it without closing it.
        if (current && current !== existing) return current;
      }
    }

    const inFlight = this.smtpConnecting.get(resolvedName);
    if (inFlight) return inFlight;

    const attempt = this.connectSmtp(account).finally(() => {
      this.smtpConnecting.delete(resolvedName);
    });
    this.smtpConnecting.set(resolvedName, attempt);
    return attempt;
  }

  private async connectSmtp(account: AccountConfig): Promise<Transporter> {
    const resolvedName = account.name;
    this.backoff.assertReady('SMTP', resolvedName);

    let transport: Transporter | undefined;
    try {
      const auth = buildSmtpAuth(account, this.oauthService);
      transport = nodemailer.createTransport(buildSmtpTransportOptions(account, auth));
      await transport.verify();
    } catch (err) {
      this.backoff.recordFailure('SMTP', resolvedName, asError(err));
      transport?.close();
      throw err;
    }
    this.backoff.recordSuccess('SMTP', resolvedName);
    await mcpLog(
      'info',
      'smtp',
      `Connected to ${account.smtp.host}:${account.smtp.port} for "${resolvedName}"`,
    );
    this.smtpTransports.set(resolvedName, transport);
    return transport;
  }

  async verifySmtpTransport(accountName?: string): Promise<void> {
    await this.getSmtpTransport(accountName, { verify: true });
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async closeAll(): Promise<void> {
    await mcpLog('info', 'connections', 'Closing all connections');
    // A connect still in flight lands in the maps when it settles; wait so it is closed too.
    await Promise.allSettled([...this.imapConnecting.values(), ...this.smtpConnecting.values()]);
    const closeOps: Promise<void>[] = [];

    Array.from(this.imapClients.entries()).forEach(([name, client]) => {
      closeOps.push(
        client
          .logout()
          .catch(() => {})
          .then(() => {
            this.imapClients.delete(name);
          }),
      );
    });

    Array.from(this.smtpTransports.entries()).forEach(([name, transport]) => {
      transport.close();
      this.smtpTransports.delete(name);
    });

    await Promise.allSettled(closeOps);
  }
}
