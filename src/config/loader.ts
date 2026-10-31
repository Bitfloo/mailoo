/**
 * Configuration loader.
 *
 * Precedence: environment variables → TOML config file → defaults.
 */

import type { Stats } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { parse as parseTOML, stringify as stringifyTOML, TomlError } from 'smol-toml';
import type {
  AccountConfig,
  AppConfig,
  HookRule,
  OAuth2Config,
  SystemOneConfig,
} from '../types/index.js';
import hasGroupOrOtherBits from '../utils/file-mode.js';
import isEnoent from '../utils/fs-errors.js';
import type { RawAccountConfig, RawAppConfig, RawAppConfigInput } from './schema.js';
import {
  AppConfigFileSchema,
  hasCredential,
  SystemOneConfigSchema,
  ToolsetSchema,
} from './schema.js';
import { CONFIG_FILE, xdg } from './xdg.js';

// ---------------------------------------------------------------------------
// Environment variable loader (single-account quick setup)
// ---------------------------------------------------------------------------

type RawAccountInput = RawAppConfigInput['accounts'][number];

/**
 * The config the environment describes, before the schema checks it. The OAuth2
 * provider is still the string as set: the schema alone decides whether it names
 * a provider, so ' google ' is refused rather than trimmed.
 */
type EnvOAuth2Config = Omit<NonNullable<RawAccountInput['oauth2']>, 'provider'> & {
  provider: string;
};
type EnvAccountConfig = Omit<RawAccountInput, 'oauth2'> & { oauth2?: EnvOAuth2Config };
type EnvAppConfig = Omit<RawAppConfigInput, 'accounts'> & { accounts: EnvAccountConfig[] };

/**
 * The OAuth2 block from MCP_EMAIL_OAUTH2_*, read as set and never trimmed.
 * An unset or empty provider means no OAuth2. A missing client value becomes ''
 * for the schema to refuse with its own message.
 */
function oauth2FromEnv(): EnvOAuth2Config | undefined {
  const provider = process.env.MCP_EMAIL_OAUTH2_PROVIDER;
  if (provider === undefined || provider === '') {
    return undefined;
  }
  return {
    provider,
    client_id: process.env.MCP_EMAIL_OAUTH2_CLIENT_ID ?? '',
    client_secret: process.env.MCP_EMAIL_OAUTH2_CLIENT_SECRET ?? '',
    refresh_token: process.env.MCP_EMAIL_OAUTH2_REFRESH_TOKEN ?? '',
  };
}

// Callers pass `process.env.MCP_EMAIL_*` itself, not the name: the published
// variable list (server.json) is checked against those literals.

/** Unset stays undefined so the schema default applies; an empty value still reaches validation. */
function intEnv(value: string | undefined): number | undefined {
  return value === undefined ? undefined : parseInt(value, 10);
}

/** Only "true" and "false" are read; any other value keeps the schema default. */
function flagEnv(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** Leaves every unset variable undefined: defaults live in the schema only. */
function loadFromEnv(): EnvAppConfig | null {
  const email = process.env.MCP_EMAIL_ADDRESS;
  const password = process.env.MCP_EMAIL_PASSWORD;
  const imapHost = process.env.MCP_EMAIL_IMAP_HOST;
  const smtpHost = process.env.MCP_EMAIL_SMTP_HOST;

  if (!email || !imapHost || !smtpHost) {
    return null;
  }

  // The same rule as the account schema. Without a credential the environment
  // describes no account, and the config file is used instead.
  const oauth2 = oauth2FromEnv();
  if (!hasCredential({ password, oauth2 })) {
    return null;
  }

  return {
    settings: {
      rate_limit: intEnv(process.env.MCP_EMAIL_RATE_LIMIT),
      read_only: flagEnv(process.env.MCP_EMAIL_READ_ONLY),
      toolset: process.env.MCP_EMAIL_TOOLSET as 'full' | 'core' | 'minimal' | undefined,
      default_account:
        (process.env.MCP_EMAIL_DEFAULT_ACCOUNT?.trim()?.length ?? 0) > 0
          ? process.env.MCP_EMAIL_DEFAULT_ACCOUNT?.trim()
          : undefined,
      save_to_sent: flagEnv(process.env.MCP_EMAIL_SAVE_TO_SENT),
      watcher: {
        enabled: flagEnv(process.env.MCP_EMAIL_WATCHER_ENABLED),
        folders: process.env.MCP_EMAIL_WATCHER_FOLDERS?.split(',')
          .map((f) => f.trim())
          .filter(Boolean),
        idle_timeout: intEnv(process.env.MCP_EMAIL_WATCHER_IDLE_TIMEOUT),
      },
      hooks: {
        on_new_email: process.env.MCP_EMAIL_HOOK_ON_NEW_EMAIL as
          | 'triage'
          | 'notify'
          | 'none'
          | undefined,
        preset: process.env.MCP_EMAIL_HOOK_PRESET as
          | 'inbox-zero'
          | 'gtd'
          | 'priority-focus'
          | 'notification-only'
          | 'custom'
          | undefined,
        auto_label: flagEnv(process.env.MCP_EMAIL_HOOK_AUTO_LABEL),
        auto_flag: flagEnv(process.env.MCP_EMAIL_HOOK_AUTO_FLAG),
        batch_delay: intEnv(process.env.MCP_EMAIL_HOOK_BATCH_DELAY),
        custom_instructions: process.env.MCP_EMAIL_HOOK_CUSTOM_INSTRUCTIONS,
        alerts: {
          desktop: flagEnv(process.env.MCP_EMAIL_ALERT_DESKTOP),
          sound: flagEnv(process.env.MCP_EMAIL_ALERT_SOUND),
          urgency_threshold: process.env.MCP_EMAIL_ALERT_URGENCY_THRESHOLD as
            | 'urgent'
            | 'high'
            | 'normal'
            | 'low'
            | undefined,
          webhook_url: process.env.MCP_EMAIL_ALERT_WEBHOOK_URL,
          allow_private_webhooks: flagEnv(process.env.MCP_EMAIL_ALERT_WEBHOOK_ALLOW_PRIVATE),
        },
        auto_calendar: flagEnv(process.env.MCP_EMAIL_HOOK_AUTO_CALENDAR),
        calendar_name: process.env.MCP_EMAIL_HOOK_CALENDAR_NAME,
        calendar_alarm_minutes: intEnv(process.env.MCP_EMAIL_HOOK_CALENDAR_ALARM_MINUTES),
        calendar_confirm: flagEnv(process.env.MCP_EMAIL_HOOK_CALENDAR_CONFIRM),
      },
      system_one: {
        enabled: flagEnv(process.env.MCP_EMAIL_SYSTEM_ONE_ENABLED),
      },
    },
    accounts: [
      {
        name: process.env.MCP_EMAIL_ACCOUNT_NAME ?? 'default',
        email,
        full_name: process.env.MCP_EMAIL_FULL_NAME,
        username: process.env.MCP_EMAIL_USERNAME,
        password,
        oauth2,
        imap: {
          host: imapHost,
          port: intEnv(process.env.MCP_EMAIL_IMAP_PORT),
          tls: flagEnv(process.env.MCP_EMAIL_IMAP_TLS),
          starttls: flagEnv(process.env.MCP_EMAIL_IMAP_STARTTLS),
          verify_ssl: flagEnv(process.env.MCP_EMAIL_IMAP_VERIFY_SSL),
          disable_imap4rev2: flagEnv(process.env.MCP_EMAIL_IMAP_DISABLE_IMAP4REV2),
          sieve_host: process.env.MCP_EMAIL_SIEVE_HOST,
          sieve_port: process.env.MCP_EMAIL_SIEVE_PORT
            ? parseInt(process.env.MCP_EMAIL_SIEVE_PORT, 10)
            : undefined,
        },
        smtp: {
          host: smtpHost,
          port: intEnv(process.env.MCP_EMAIL_SMTP_PORT),
          tls: flagEnv(process.env.MCP_EMAIL_SMTP_TLS),
          starttls: flagEnv(process.env.MCP_EMAIL_SMTP_STARTTLS),
          verify_ssl: flagEnv(process.env.MCP_EMAIL_SMTP_VERIFY_SSL),
          pool: {
            enabled: flagEnv(process.env.MCP_EMAIL_SMTP_POOL_ENABLED),
            max_connections: intEnv(process.env.MCP_EMAIL_SMTP_POOL_MAX_CONNECTIONS),
            max_messages: intEnv(process.env.MCP_EMAIL_SMTP_POOL_MAX_MESSAGES),
          },
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// TOML file loader
// ---------------------------------------------------------------------------

function assertConfigPath(filePath: string): void {
  if (filePath.includes('\0')) {
    throw new Error('Config path is not valid');
  }
}

async function lstatOrNull(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function warnIfGroupOrOtherCanRead(filePath: string, mode: number): void {
  if (!hasGroupOrOtherBits(mode)) return;
  // Config is read before the MCP handshake, so a client log would be dropped.
  process.stderr.write(
    `[mailoo] warning: config file is readable by group or other. Run: chmod 600 ${filePath}\n`,
  );
}

async function loadFromFile(filePath: string = CONFIG_FILE): Promise<RawAppConfig | null> {
  assertConfigPath(filePath);
  let info: Stats;
  try {
    info = await fs.stat(filePath);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  if (!info.isFile()) return null;
  warnIfGroupOrOtherCanRead(filePath, info.mode);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  try {
    return parseTOML(content) as unknown as RawAppConfig;
  } catch (error) {
    if (!(error instanceof TomlError)) throw error;
    // The first line only: the rest quotes the file, which may hold a password.
    const reason = error.message.split('\n')[0];
    throw new Error(
      `Config file ${filePath} is not valid TOML (line ${error.line}, column ${error.column}): ${reason}`,
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// Normalize raw config → typed AppConfig
// ---------------------------------------------------------------------------

function normalizeOAuth2(raw: NonNullable<RawAccountConfig['oauth2']>): OAuth2Config {
  return {
    provider: raw.provider,
    clientId: raw.client_id,
    clientSecret: raw.client_secret,
    refreshToken: raw.refresh_token,
    tokenUrl: raw.token_url,
    authUrl: raw.auth_url,
    scopes: raw.scopes,
  };
}

export function normalizeAccount(raw: RawAccountConfig): AccountConfig {
  return {
    name: raw.name,
    email: raw.email,
    fullName: raw.full_name,
    username: raw.username ?? raw.email,
    password: raw.password,
    oauth2: raw.oauth2 ? normalizeOAuth2(raw.oauth2) : undefined,
    sentMailbox: raw.sent_mailbox,
    imap: {
      host: raw.imap.host,
      port: raw.imap.port,
      tls: raw.imap.tls,
      starttls: raw.imap.starttls,
      verifySsl: raw.imap.verify_ssl,
      disableImap4rev2: raw.imap.disable_imap4rev2,
      sieveHost: raw.imap.sieve_host,
      sievePort: raw.imap.sieve_port,
    },
    smtp: {
      host: raw.smtp.host,
      port: raw.smtp.port,
      tls: raw.smtp.tls,
      starttls: raw.smtp.starttls,
      verifySsl: raw.smtp.verify_ssl,
      pool: {
        enabled: raw.smtp.pool.enabled,
        maxConnections: raw.smtp.pool.max_connections,
        maxMessages: raw.smtp.pool.max_messages,
      },
    },
  };
}

function normalizeHookRule(raw: {
  name: string;
  match: Record<string, string | undefined>;
  actions: Record<string, unknown>;
}): HookRule {
  return {
    name: raw.name,
    match: {
      from: raw.match.from,
      to: raw.match.to,
      subject: raw.match.subject,
    },
    actions: {
      labels: Array.isArray(raw.actions.labels) ? (raw.actions.labels as string[]) : undefined,
      flag: typeof raw.actions.flag === 'boolean' ? raw.actions.flag : undefined,
      markRead: typeof raw.actions.mark_read === 'boolean' ? raw.actions.mark_read : undefined,
      alert: typeof raw.actions.alert === 'boolean' ? raw.actions.alert : undefined,
      addToCalendar:
        typeof raw.actions.add_to_calendar === 'boolean' ? raw.actions.add_to_calendar : undefined,
      moveTo: typeof raw.actions.move_to === 'string' ? raw.actions.move_to : undefined,
    },
  };
}

function normalizeSystemOne(
  raw: RawAppConfig['settings']['system_one'] | undefined,
): SystemOneConfig {
  const parsed = SystemOneConfigSchema.parse(raw ?? {});
  return {
    enabled: parsed.enabled,
    model: parsed.model,
    includeBody: parsed.include_body,
    bodyMaxChars: parsed.body_max_chars,
    autoMove: parsed.auto_move,
    autoFlag: parsed.auto_flag,
    folders: parsed.folders.map((folder) => ({
      path: folder.path,
      description: folder.description,
      falseCriteria: folder.false_criteria,
      priority: folder.priority,
    })),
    sourceFolders: parsed.source_folders,
    thresholds: {
      folderFitMin: parsed.thresholds.folder_fit_min,
      spamHigh: parsed.thresholds.spam_high,
      spamUncertainLow: parsed.thresholds.spam_uncertain_low,
      spamUncertainHigh: parsed.thresholds.spam_uncertain_high,
      injectionHigh: parsed.thresholds.injection_high,
      importanceFlagMin: parsed.thresholds.importance_flag_min,
      importanceMinConfidence: parsed.thresholds.importance_min_confidence,
      isCriticalMin: parsed.thresholds.is_critical_min,
    },
  };
}

function normalizeConfig(raw: RawAppConfig): AppConfig {
  const envToolset = process.env.MCP_EMAIL_TOOLSET?.trim();
  const envDefaultAccount = process.env.MCP_EMAIL_DEFAULT_ACCOUNT?.trim();
  const toolset =
    envToolset !== undefined && envToolset.length > 0
      ? ToolsetSchema.parse(envToolset)
      : raw.settings.toolset;
  const defaultAccount =
    envDefaultAccount !== undefined && envDefaultAccount.length > 0
      ? envDefaultAccount
      : raw.settings.default_account;
  return {
    settings: {
      rateLimit: raw.settings.rate_limit,
      readOnly: flagEnv(process.env.MCP_EMAIL_READ_ONLY) ?? raw.settings.read_only,
      toolset,
      defaultAccount,
      saveToSent: raw.settings.save_to_sent,
      watcher: {
        enabled: raw.settings.watcher.enabled,
        folders: raw.settings.watcher.folders,
        idleTimeout: raw.settings.watcher.idle_timeout,
      },
      systemOne: normalizeSystemOne(raw.settings.system_one),
      hooks: {
        onNewEmail: raw.settings.hooks.on_new_email,
        preset: raw.settings.hooks.preset,
        autoLabel: raw.settings.hooks.auto_label,
        autoFlag: raw.settings.hooks.auto_flag,
        batchDelay: raw.settings.hooks.batch_delay,
        customInstructions: raw.settings.hooks.custom_instructions,
        systemPrompt: raw.settings.hooks.system_prompt,
        rules: raw.settings.hooks.rules.map(normalizeHookRule),
        alerts: {
          desktop: raw.settings.hooks.alerts.desktop,
          sound: raw.settings.hooks.alerts.sound,
          urgencyThreshold: raw.settings.hooks.alerts.urgency_threshold,
          webhookUrl: raw.settings.hooks.alerts.webhook_url,
          webhookEvents: raw.settings.hooks.alerts.webhook_events,
          allowPrivateWebhooks: raw.settings.hooks.alerts.allow_private_webhooks,
        },
        autoCalendar: raw.settings.hooks.auto_calendar,
        calendarName: raw.settings.hooks.calendar_name,
        calendarAlarmMinutes: raw.settings.hooks.calendar_alarm_minutes,
        calendarConfirm: raw.settings.hooks.calendar_confirm,
      },
    },
    accounts: raw.accounts.map(normalizeAccount),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load raw (snake_case) config from TOML file without normalization.
 * Useful for read-modify-write operations in CLI commands.
 * Throws if no config file exists or validation fails.
 */
export async function loadRawConfig(configPath?: string): Promise<RawAppConfig> {
  const filePath = configPath ?? CONFIG_FILE;
  const fileConfig = await loadFromFile(filePath);
  if (!fileConfig) {
    throw new Error(`No config file found at: ${filePath}`);
  }
  return AppConfigFileSchema.parse(fileConfig);
}

/**
 * Load and validate configuration from env vars or TOML file.
 * Throws on validation errors.
 */
export async function loadConfig(configPath?: string): Promise<AppConfig> {
  // 1. Try environment variables first
  const envConfig = loadFromEnv();
  if (envConfig) {
    const validated = AppConfigFileSchema.parse(envConfig);
    return normalizeConfig(validated);
  }

  // 2. Fall back to TOML config file
  const fileConfig = await loadFromFile(configPath);
  if (fileConfig) {
    const validated = AppConfigFileSchema.parse(fileConfig);
    return normalizeConfig(validated);
  }

  throw new Error(
    `No configuration found.\n\n` +
      `Set environment variables (MCP_EMAIL_ADDRESS, MCP_EMAIL_PASSWORD, etc.)\n` +
      `or create a config file at: ${configPath ?? CONFIG_FILE}\n\n` +
      `Run 'mailoo account add' for interactive configuration.`,
  );
}

/**
 * Mode 0700 applies only to a directory this call creates. chmod on an
 * existing path would follow a symlink and change a directory Mailoo did not create.
 */
async function ensureConfigDirectory(dir: string): Promise<void> {
  const existing = await lstatOrNull(dir);
  if (existing) {
    const followed = await fs.stat(dir);
    if (!followed.isDirectory()) {
      throw new Error('Config path is not valid');
    }
    return;
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const created = await fs.lstat(dir);
  // lstat, not stat: a symlink here is not a directory this call created.
  if (created.isDirectory()) {
    await fs.chmod(dir, 0o700);
  }
}

async function resolveWriteTarget(filePath: string): Promise<string> {
  const dest = await lstatOrNull(filePath);
  if (dest?.isSymbolicLink() || dest?.isFile()) {
    const targetPath = await fs.realpath(filePath);
    const targetInfo = await fs.stat(targetPath);
    if (!targetInfo.isFile()) {
      throw new Error('Config path is not valid');
    }
    return targetPath;
  }
  if (dest) {
    throw new Error('Config path is not valid');
  }
  const parentReal = await fs.realpath(path.dirname(filePath));
  return path.join(parentReal, path.basename(filePath));
}

/**
 * Write config text. A symlink stays a symlink and the target file changes,
 * because renaming onto the link itself would replace the link. Config files
 * Mailoo writes are mode 0600 (an existing file's mode is replaced).
 */
export async function writeConfigFile(filePath: string, contents: string): Promise<void> {
  assertConfigPath(filePath);
  await ensureConfigDirectory(path.dirname(filePath));
  const targetPath = await resolveWriteTarget(filePath);
  const tmpPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.tmp`,
  );
  const existingTmp = await lstatOrNull(tmpPath);
  if (existingTmp?.isSymbolicLink() || existingTmp?.isFile()) {
    await fs.unlink(tmpPath);
  } else if (existingTmp) {
    throw new Error('Config path is not valid');
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  // Open flags are a bitmask; O_EXCL creates only a new file and O_NOFOLLOW refuses a symlink.
  // eslint-disable-next-line no-bitwise
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
  const handle = await fs.open(tmpPath, flags, 0o600);
  try {
    await handle.writeFile(contents, 'utf-8');
  } finally {
    await handle.close();
  }
  try {
    await fs.chmod(tmpPath, 0o600);
    await fs.rename(tmpPath, targetPath);
  } catch (error) {
    // The temp file holds the config text. Do not leave it behind if replace fails.
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Save configuration to a TOML file.
 */
export async function saveConfig(
  config: RawAppConfig,
  filePath: string = CONFIG_FILE,
): Promise<void> {
  const toml = stringifyTOML(config);
  await writeConfigFile(filePath, toml);
}

/**
 * Generate a template TOML config string.
 */
export function generateTemplate(): string {
  return `# Mailoo Configuration
# Location: ${CONFIG_FILE}

[settings]
rate_limit = 10  # max emails per minute per account
read_only = false  # set to true to disable all write operations
save_to_sent = true  # IMAP APPEND to \\Sent after SMTP send (set false for Gmail)

# [settings.watcher]
# enabled = false        # enable IMAP IDLE real-time monitoring
# folders = ["INBOX"]    # folders to watch per account
# idle_timeout = 1740    # seconds (29 min, IMAP max is 30)

# [settings.hooks]
# on_new_email = "notify"  # "triage" (AI) | "notify" (log) | "none"
# preset = "priority-focus" # "inbox-zero" | "gtd" | "priority-focus" | "notification-only" | "custom"
# auto_label = false       # auto-apply AI-suggested labels
# auto_flag = false        # auto-flag urgent emails
# batch_delay = 5          # seconds to batch before processing
# custom_instructions = "I'm a software engineer. Emails from @example.com are high priority."
# system_prompt = ""       # full override (only when preset = "custom")

# Static rules — run BEFORE AI triage, skip AI if matched
# [[settings.hooks.rules]]
# name = "GitHub Notifications"
# match = { from = "*@github.com" }
# actions = { labels = ["Dev"], mark_read = true }
#
# [[settings.hooks.rules]]
# name = "VIP Contacts"
# match = { from = "ceo@example.com" }
# actions = { flag = true, alert = true, labels = ["VIP"] }

# [settings.hooks.alerts]
# desktop = false         # enable OS-level desktop notifications
# sound = false           # play sound for urgent emails
# urgency_threshold = "high" # minimum priority: "urgent" | "high" | "normal" | "low"
# webhook_url = ""        # HTTP POST to Slack/Discord/ntfy.sh/etc.
# webhook_events = ["urgent", "high"]  # which priorities trigger webhook
# allow_private_webhooks = false  # off by default; true permits LAN, VPN, and tailnet webhook URLs

# [settings.system_one]
# enabled = false          # requires watcher.enabled too; TYPESAFE_API_KEY from env only
# model = "jev-latest"
# include_body = false     # default sends mail_headers; true additionally sends mail_body
# auto_move = false
# auto_flag = false
# # [[settings.system_one.folders]]
# # path = "Receipts"
# # description = "Invoices, receipts, and payment confirmations."

[[accounts]]
name = "personal"
email = "you@example.com"
full_name = "Your Name"
# username defaults to email if omitted
# username = "you@example.com"
password = "your-app-password"

[accounts.imap]
host = "imap.example.com"
port = 993
tls = true
starttls = false
verify_ssl = true
# disable_imap4rev2 = true  # set for hosts with broken IMAP4rev2 SEARCH (e.g. Strato)
# sieve_host = "imap.example.com"
# sieve_port = 4190

[accounts.smtp]
host = "smtp.example.com"
port = 465
tls = true
starttls = false
verify_ssl = true

[accounts.smtp.pool]
enabled = true
max_connections = 1
max_messages = 100
`;
}

/**
 * Check if a config file exists at the default XDG path.
 */
export async function configExists(filePath: string = CONFIG_FILE): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Re-export for convenience */
export { CONFIG_FILE, xdg };
