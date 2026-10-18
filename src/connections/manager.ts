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

import type OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';
import type { IConnectionManager } from './types.js';

type SmtpAuth =
  | { user: string; pass?: string }
  | { type: string; user: string; accessToken: string };

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

  private smtpTransports = new Map<string, Transporter>();

  private accounts = new Map<string, AccountConfig>();

  private oauthService?: OAuthService;

  private defaultAccount?: string;

  constructor(accounts: AccountConfig[], oauthService?: OAuthService, defaultAccount?: string) {
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
    const byName = values.find((account) => account.name.toLowerCase() === lower);
    if (byName) return byName;
    return values.find((account) => account.email.toLowerCase() === lower);
  }

  private formatAvailableAccounts(): string {
    if (this.accounts.size === 0) return 'none';
    return [...this.accounts.values()].map((a) => `${a.name} (${a.email})`).join(', ');
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

    // Build auth config based on auth type
    let auth: { user: string; pass?: string; accessToken?: string };
    if (account.oauth2 && this.oauthService) {
      const accessToken = await this.oauthService.getAccessToken(account.oauth2);
      auth = { user: account.username, accessToken };
    } else {
      auth = { user: account.username, pass: account.password };
    }

    const client = new ImapFlow({
      ...buildImapFlowOptions(account),
      auth,
    });
    bindImapLifecycle(resolvedName, client, () => {
      if (this.imapClients.get(resolvedName) === client) {
        this.imapClients.delete(resolvedName);
      }
    });

    await client.connect();
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
        this.smtpTransports.delete(resolvedName);
        try {
          existing.close();
        } catch {
          /* ignore */
        }
      }
    }

    // Build auth config based on auth type
    let auth: SmtpAuth;
    if (account.oauth2 && this.oauthService) {
      const accessToken = await this.oauthService.getAccessToken(account.oauth2);
      auth = { type: 'OAuth2', user: account.username, accessToken };
    } else {
      auth = { user: account.username, pass: account.password };
    }

    const transport = nodemailer.createTransport(
      ConnectionManager.buildSmtpTransportOptions(account, auth),
    );

    await transport.verify();
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
  // Test connections (for setup wizard / test command)
  // -------------------------------------------------------------------------

  static async testImap(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{
    success: boolean;
    error?: string;
    details?: { messages: number; folders: number };
  }> {
    let client: ImapFlow | undefined;
    try {
      let auth: { user: string; pass?: string; accessToken?: string };
      if (account.oauth2 && oauthService) {
        const accessToken = await oauthService.getAccessToken(account.oauth2);
        auth = { user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

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
    oauthService?: OAuthService,
  ): Promise<{ success: boolean; error?: string }> {
    let transport: Transporter | undefined;
    try {
      let auth: SmtpAuth;
      if (account.oauth2 && oauthService) {
        const accessToken = await oauthService.getAccessToken(account.oauth2);
        auth = { type: 'OAuth2', user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

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
