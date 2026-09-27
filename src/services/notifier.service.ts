/**
 * NotifierService — multi-channel notification dispatcher.
 *
 * Routes email alerts to the appropriate channels based on urgency:
 * - Desktop notifications (native OS commands — zero npm deps)
 * - Sound alerts (via OS notification sound)
 * - MCP log level escalation (urgent→alert, high→warning, …)
 * - Webhook dispatch (HTTP POST to Slack/Discord/ntfy.sh/etc.)
 *
 * All channels are opt-in and disabled by default.
 */

import { execFile } from 'node:child_process';
import { mcpLog } from '../logging.js';
import { resolveWebhookUrl, validateWebhookUrl } from '../safety/validation.js';

import type { AlertsConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UrgencyLevel = 'urgent' | 'high' | 'normal' | 'low';

export interface AlertPayload {
  account: string;
  sender: { name?: string; address: string };
  subject: string;
  priority: UrgencyLevel;
  labels?: string[];
  ruleName?: string;
  uid?: string;
  messageId?: string;
  folder?: string;
  hasAttachments?: boolean;
}

export interface PlatformDiagnostics {
  platform: string;
  supported: boolean;
  desktopTool: { name: string; available: boolean };
  soundTool: { name: string; available: boolean };
  issues: string[];
  setupInstructions: string[];
}

// ---------------------------------------------------------------------------
// Priority ordering for threshold comparison
// ---------------------------------------------------------------------------

const URGENCY_ORDER: Record<UrgencyLevel, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const MCP_LOG_LEVEL_MAP: Record<UrgencyLevel, 'alert' | 'warning' | 'info' | 'debug'> = {
  urgent: 'alert',
  high: 'warning',
  normal: 'info',
  low: 'debug',
};

const URGENCY_LEVELS: readonly UrgencyLevel[] = ['urgent', 'high', 'normal', 'low'];

/** Webhook URLs are stored in the config file; keep them bounded. */
export const MAX_WEBHOOK_URL_CHARS = 2048;

/** Fixed sound file. Runtime alert settings cannot replace this path. */
const FREEDESKTOP_MESSAGE_SOUND = '/usr/share/sounds/freedesktop/stereo/message-new-instant.oga';

/** Desktop banners show a short line; bound the text passed to the OS notifier. */
const MAX_NOTIFICATION_FIELD_CHARS = 200;

export interface DesktopNotificationCommand {
  bin: string;
  args: string[];
  env?: Record<string, string>;
}

function isUrgency(value: string): value is UrgencyLevel {
  return (URGENCY_LEVELS as readonly string[]).includes(value);
}

function assertWebhookUrl(url: string, allowPrivate: boolean): void {
  if (url.length > MAX_WEBHOOK_URL_CHARS) {
    throw new Error('Webhook URL is too long');
  }
  /* eslint-disable no-control-regex */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in webhook URLs
  if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(url)) {
    throw new Error('Webhook URL must not contain control characters');
  }
  /* eslint-enable no-control-regex */
  validateWebhookUrl(url, { allowPrivate });
  const parsed = new URL(url);
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Webhook URL must not include credentials');
  }
}

/**
 * Merge a runtime alert update.
 * `allowPrivateWebhooks` stays as loaded from the config file.
 */
export function applyAlertsPatch(
  current: AlertsConfig,
  partial: Partial<AlertsConfig>,
): AlertsConfig {
  if (partial.desktop !== undefined && typeof partial.desktop !== 'boolean') {
    throw new Error('desktop must be a boolean');
  }
  if (partial.sound !== undefined && typeof partial.sound !== 'boolean') {
    throw new Error('sound must be a boolean');
  }
  if (partial.urgencyThreshold !== undefined && !isUrgency(partial.urgencyThreshold)) {
    throw new Error('urgency threshold must be urgent, high, normal, or low');
  }
  if (partial.webhookEvents !== undefined) {
    const events = partial.webhookEvents as readonly string[];
    if (
      !Array.isArray(events) ||
      events.length > URGENCY_LEVELS.length ||
      events.some((level) => !isUrgency(level))
    ) {
      throw new Error('webhook events must be urgency levels');
    }
  }
  if (partial.webhookUrl !== undefined && partial.webhookUrl !== '') {
    assertWebhookUrl(partial.webhookUrl, current.allowPrivateWebhooks === true);
  }

  return {
    desktop: partial.desktop ?? current.desktop,
    sound: partial.sound ?? current.sound,
    urgencyThreshold: partial.urgencyThreshold ?? current.urgencyThreshold,
    webhookUrl: partial.webhookUrl ?? current.webhookUrl,
    webhookEvents: partial.webhookEvents ?? current.webhookEvents,
    allowPrivateWebhooks: current.allowPrivateWebhooks,
  };
}

function notificationField(text: string): string {
  return text.replace(/\0/g, '').slice(0, MAX_NOTIFICATION_FIELD_CHARS);
}

/**
 * Build desktop notification commands.
 * Title and body are data (argv or environment), never part of the script text.
 */
export function desktopNotificationCommands(
  platform: NodeJS.Platform,
  title: string,
  body: string,
  sound: boolean,
): DesktopNotificationCommand[] {
  const safeTitle = notificationField(title);
  const safeBody = notificationField(body);
  const env = {
    MAILOO_NOTIFY_TITLE: safeTitle,
    MAILOO_NOTIFY_BODY: safeBody,
  };

  if (platform === 'darwin') {
    const soundClause = sound ? ' sound name "Glass"' : '';
    return [
      {
        bin: 'osascript',
        args: [
          '-e',
          'on run argv',
          '-e',
          `display notification (item 2 of argv) with title (item 1 of argv)${soundClause}`,
          '-e',
          'end run',
          // osascript would parse a trailing argument starting with -e as another statement
          '--',
          safeTitle,
          safeBody,
        ],
      },
    ];
  }

  if (platform === 'linux') {
    const commands: DesktopNotificationCommand[] = [
      {
        bin: 'notify-send',
        args: ['-u', sound ? 'critical' : 'normal', '--', safeTitle, safeBody],
      },
    ];
    if (sound) {
      commands.push({ bin: 'paplay', args: [FREEDESKTOP_MESSAGE_SOUND] });
    }
    return commands;
  }

  if (platform === 'win32') {
    const script = [
      "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')",
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Information',
      '$n.Visible = $true',
      "$n.ShowBalloonTip(5000, $env:MAILOO_NOTIFY_TITLE, $env:MAILOO_NOTIFY_BODY, 'Info')",
    ].join('; ');
    return [
      {
        bin: 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-Command', script],
        env,
      },
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// NotifierService
// ---------------------------------------------------------------------------

export default class NotifierService {
  private config: AlertsConfig;

  private desktopCount = 0;

  private desktopResetTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly MAX_DESKTOP_PER_MIN = 5;

  constructor(config: AlertsConfig) {
    this.config = config;

    // Reset desktop rate counter every 60s
    this.desktopResetTimer = setInterval(() => {
      this.desktopCount = 0;
    }, 60_000);
  }

  stop(): void {
    if (this.desktopResetTimer) {
      clearInterval(this.desktopResetTimer);
      this.desktopResetTimer = null;
    }
  }

  /** Returns the current alerts configuration. */
  getConfig(): AlertsConfig {
    return { ...this.config };
  }

  /** Updates alert configuration at runtime (partial merge). */
  updateConfig(partial: Partial<AlertsConfig>): AlertsConfig {
    this.config = applyAlertsPatch(this.config, partial);
    return this.getConfig();
  }

  // -------------------------------------------------------------------------
  // Platform diagnostics — check if notification tools are available
  // -------------------------------------------------------------------------

  static async checkPlatformSupport(): Promise<PlatformDiagnostics> {
    const { platform } = process;
    const issues: string[] = [];
    const instructions: string[] = [];

    if (platform === 'darwin') {
      const osascriptOk = await NotifierService.commandExists('osascript');
      const afplayOk = await NotifierService.commandExists('afplay');

      if (!osascriptOk) issues.push('osascript not found (should be built-in on macOS)');

      instructions.push(
        '1. Open System Settings → Notifications & Focus',
        '2. Find your terminal app (Terminal, iTerm2, VS Code, Cursor, etc.)',
        '3. Enable "Allow Notifications" and choose "Banners" or "Alerts"',
        '4. Ensure "Do Not Disturb" / Focus mode is not active',
        '5. If using an MCP client, the notification appears from the terminal running the server',
      );

      return {
        platform: 'macOS',
        supported: osascriptOk,
        desktopTool: { name: 'osascript', available: osascriptOk },
        soundTool: { name: 'afplay', available: afplayOk },
        issues,
        setupInstructions: instructions,
      };
    }

    if (platform === 'linux') {
      const notifySendOk = await NotifierService.commandExists('notify-send');
      const paplayOk = await NotifierService.commandExists('paplay');

      if (!notifySendOk) {
        issues.push('notify-send not found');
        instructions.push(
          'Install libnotify:',
          '  Ubuntu/Debian: sudo apt install libnotify-bin',
          '  Fedora:        sudo dnf install libnotify',
          '  Arch:          sudo pacman -S libnotify',
        );
      }
      if (!paplayOk) {
        issues.push('paplay not found (needed for sound alerts)');
        instructions.push(
          'Install PulseAudio utils for sound:',
          '  Ubuntu/Debian: sudo apt install pulseaudio-utils',
          '  Fedora:        sudo dnf install pulseaudio-utils',
        );
      }

      instructions.push(
        'Note: Desktop notifications require a running display server (X11/Wayland).',
        'They will not work in headless/SSH sessions.',
      );

      return {
        platform: 'Linux',
        supported: notifySendOk,
        desktopTool: { name: 'notify-send', available: notifySendOk },
        soundTool: { name: 'paplay', available: paplayOk },
        issues,
        setupInstructions: instructions,
      };
    }

    if (platform === 'win32') {
      const psOk = await NotifierService.commandExists('powershell');

      if (!psOk) issues.push('PowerShell not found');

      instructions.push(
        '1. Open Settings → System → Notifications',
        '2. Ensure "Notifications" is turned on',
        '3. Ensure "Focus Assist" is set to allow notifications',
        '4. If using Windows Terminal, ensure its notifications are enabled',
      );

      return {
        platform: 'Windows',
        supported: psOk,
        desktopTool: { name: 'powershell', available: psOk },
        soundTool: { name: 'powershell', available: psOk },
        issues,
        setupInstructions: instructions,
      };
    }

    return {
      platform,
      supported: false,
      desktopTool: { name: 'unknown', available: false },
      soundTool: { name: 'unknown', available: false },
      issues: [`Unsupported platform: ${platform}. Desktop notifications are not available.`],
      setupInstructions: ['Desktop notifications are only supported on macOS, Linux, and Windows.'],
    };
  }

  /** Test if a command-line tool exists on the system. */
  private static async commandExists(cmd: string): Promise<boolean> {
    const bin = process.platform === 'win32' ? 'where' : 'which';
    return new Promise((resolve) => {
      execFile(bin, [cmd], { timeout: 3000 }, (err) => {
        resolve(!err);
      });
    });
  }

  /** Send a test notification to verify platform setup. */
  async sendTestNotification(withSound = false): Promise<{ success: boolean; message: string }> {
    const diag = await NotifierService.checkPlatformSupport();
    if (!diag.supported) {
      return {
        success: false,
        message: `Desktop notifications not supported: ${diag.issues.join('; ')}`,
      };
    }

    // Temporarily force desktop + sound for the test
    const origDesktop = this.config.desktop;
    const origSound = this.config.sound;
    this.config.desktop = true;
    this.config.sound = withSound;

    try {
      const testPayload: AlertPayload = {
        account: 'test',
        sender: { name: 'Mailoo', address: 'test@mailoo.invalid' },
        subject: 'If you see this, notifications work!',
        priority: 'urgent',
      };
      await this.sendDesktopNotification(testPayload);
      return {
        success: true,
        message: withSound
          ? 'Test notification sent with sound. Check your notification center.'
          : 'Test notification sent. Check your notification center.',
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Notification failed: ${errMsg}. Check platform setup instructions.`,
      };
    } finally {
      this.config.desktop = origDesktop;
      this.config.sound = origSound;
    }
  }

  // -------------------------------------------------------------------------
  // Main dispatch — routes alert to channels based on urgency + config
  // -------------------------------------------------------------------------

  async alert(payload: AlertPayload, forceDesktop = false): Promise<void> {
    const meetsThreshold =
      URGENCY_ORDER[payload.priority] >= URGENCY_ORDER[this.config.urgencyThreshold];

    // 1. MCP log — always, with appropriate level
    const logLevel = MCP_LOG_LEVEL_MAP[payload.priority];
    const icon = payload.priority === 'urgent' ? '🚨' : '📧';
    const logMsg = `${icon} [${payload.priority.toUpperCase()}] ${payload.sender.name ?? payload.sender.address}: "${payload.subject}"${
      payload.labels?.length ? ` [${payload.labels.join(', ')}]` : ''
    }${payload.ruleName ? ` (rule: ${payload.ruleName})` : ''}`;
    await mcpLog(logLevel, 'notifier', logMsg);

    // 2. Desktop notification — if enabled + meets threshold (or forced by rule)
    if (this.config.desktop && (meetsThreshold || forceDesktop)) {
      await this.sendDesktopNotification(payload);
    }

    // 3. Webhook — if configured + meets webhook event filter
    if (this.config.webhookUrl && this.config.webhookEvents.includes(payload.priority)) {
      this.sendWebhook(payload).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Desktop notification — native OS commands, zero npm deps
  // -------------------------------------------------------------------------

  private async sendDesktopNotification(payload: AlertPayload): Promise<void> {
    if (this.desktopCount >= NotifierService.MAX_DESKTOP_PER_MIN) return;
    this.desktopCount += 1;

    const title = `📧 Mailoo — ${payload.priority === 'urgent' ? 'Urgent' : 'Important'}`;
    const senderDisplay = payload.sender.name ?? payload.sender.address;
    const body = `From: ${senderDisplay}\n${payload.subject}`;
    const playSound = this.config.sound && payload.priority === 'urgent';
    const commands = desktopNotificationCommands(process.platform, title, body, playSound);

    try {
      await commands.reduce(async (previous, command) => {
        await previous;
        try {
          await NotifierService.execCommand(command.bin, command.args, command.env);
        } catch (err) {
          if (command.bin !== 'paplay') throw err;
        }
      }, Promise.resolve());
    } catch {
      // Desktop notification failure is non-fatal — silently degrade to MCP log only
    }
  }

  private static async execCommand(
    bin: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<void> {
    const options: { timeout: number; env?: NodeJS.ProcessEnv } = { timeout: 5000 };
    if (env) options.env = { ...process.env, ...env };
    return new Promise((resolve, reject) => {
      execFile(bin, args, options, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Webhook dispatch — HTTP POST with JSON payload
  // -------------------------------------------------------------------------

  private async sendWebhook(payload: AlertPayload): Promise<void> {
    if (!this.config.webhookUrl) return;

    try {
      await resolveWebhookUrl(this.config.webhookUrl, {
        allowPrivate: this.config.allowPrivateWebhooks === true,
      });
    } catch (err) {
      await mcpLog(
        'warning',
        'notifier',
        `Invalid webhook URL: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const body = JSON.stringify({
      event: `email.${payload.priority}`,
      account: payload.account,
      uid: payload.uid ?? null,
      messageId: payload.messageId ?? null,
      folder: payload.folder ?? null,
      sender: payload.sender,
      subject: payload.subject,
      hasAttachments: payload.hasAttachments ?? false,
      priority: payload.priority,
      labels: payload.labels ?? [],
      rule: payload.ruleName ?? null,
      timestamp: new Date().toISOString(),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const resp = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      if (!resp.ok) {
        await mcpLog('warning', 'notifier', `Webhook returned ${resp.status}`);
      }
    } catch {
      await mcpLog('debug', 'notifier', 'Webhook dispatch failed (non-fatal)');
    } finally {
      clearTimeout(timeout);
    }
  }
}
