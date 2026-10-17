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

  private oauthService?: AccessTokenSource;

  constructor(accounts: AccountConfig[], oauthService?: AccessTokenSource) {
    accounts.forEach((account) => {
      this.accounts.set(account.name, account);
    });
    this.oauthService = oauthService;
  }

  // -------------------------------------------------------------------------
  // Account lookup
  // -------------------------------------------------------------------------

  getAccount(name: string): AccountConfig {
    const account = this.accounts.get(name);
    if (!account) {
      throw new Error(
        `Account "${name}" not found. Available: ${[...this.accounts.keys()].join(', ')}`,
      );
    }
    return account;
  }

  getAccountNames(): string[] {
    return [...this.accounts.keys()];
  }

  // -------------------------------------------------------------------------
  // IMAP
  // -------------------------------------------------------------------------

  async getImapClient(accountName: string): Promise<ImapFlow> {
    const existing = this.imapClients.get(accountName);
    if (existing?.usable) {
      return existing;
    }

    // Clean up stale connection
    if (existing) {
      this.imapClients.delete(accountName);
      try {
        existing.close();
      } catch {
        /* ignore */
      }
    }

    const inFlight = this.imapConnecting.get(accountName);
    if (inFlight) return inFlight;

    const attempt = this.connectImap(accountName).finally(() => {
      this.imapConnecting.delete(accountName);
    });
    this.imapConnecting.set(accountName, attempt);
    return attempt;
  }

  private async connectImap(accountName: string): Promise<ImapFlow> {
    const account = this.getAccount(accountName);
    const auth = await buildImapAuth(account, this.oauthService);

    const client = new ImapFlow({
      ...buildImapFlowOptions(account),
      auth,
    });
    bindImapLifecycle(accountName, client, () => {
      if (this.imapClients.get(accountName) === client) {
        this.imapClients.delete(accountName);
      }
    });

    await client.connect();
    await mcpLog(
      'info',
      'imap',
      `Connected to ${account.imap.host}:${account.imap.port} for "${accountName}"`,
    );
    this.imapClients.set(accountName, client);
    return client;
  }

  // -------------------------------------------------------------------------
  // SMTP
  // -------------------------------------------------------------------------

  private static buildSmtpTransportOptions(
    account: AccountConfig,
    auth: SmtpAuth,
  ): SMTPPoolOptions {
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

  async getSmtpTransport(
    accountName: string,
    options?: { verify?: boolean },
  ): Promise<Transporter> {
    const verify = options?.verify ?? false;
    const existing = this.smtpTransports.get(accountName);
    if (existing) {
      if (!verify) {
        return existing;
      }
      try {
        await existing.verify();
        return existing;
      } catch {
        if (this.smtpTransports.get(accountName) === existing) {
          this.smtpTransports.delete(accountName);
        }
        try {
          existing.close();
        } catch {
          /* ignore */
        }
      }
    }

    const inFlight = this.smtpConnecting.get(accountName);
    if (inFlight) return inFlight;

    const attempt = this.connectSmtp(accountName).finally(() => {
      this.smtpConnecting.delete(accountName);
    });
    this.smtpConnecting.set(accountName, attempt);
    return attempt;
  }

  private async connectSmtp(accountName: string): Promise<Transporter> {
    const account = this.getAccount(accountName);
    const auth = await buildSmtpAuth(account, this.oauthService);

    const transport = nodemailer.createTransport(
      ConnectionManager.buildSmtpTransportOptions(account, auth),
    );

    await transport.verify();
    await mcpLog(
      'info',
      'smtp',
      `Connected to ${account.smtp.host}:${account.smtp.port} for "${accountName}"`,
    );
    this.smtpTransports.set(accountName, transport);
    return transport;
  }

  async verifySmtpTransport(accountName: string): Promise<void> {
    await this.getSmtpTransport(accountName, { verify: true });
  }

  // -------------------------------------------------------------------------
  // Test connections (for setup wizard / test command)
  // -------------------------------------------------------------------------

  static async testImap(
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
        messageCount = inbox.messages ?? 0;
      } catch {
        // INBOX may not exist (e.g. Google Workspace uses "All Mail")
        if (mailboxes.length > 0) {
          try {
            const first = await client.status(mailboxes[0].path, {
              messages: true,
            });
            messageCount = first.messages ?? 0;
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
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
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

  static async testSmtp(
    account: AccountConfig,
    oauthService?: AccessTokenSource,
  ): Promise<{ success: boolean; error?: string }> {
    let transport: Transporter | undefined;
    try {
      const auth = await buildSmtpAuth(account, oauthService);

      transport = nodemailer.createTransport(
        ConnectionManager.buildSmtpTransportOptions(account, auth),
      );
      await transport.verify();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      transport?.close();
    }
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
