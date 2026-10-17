/**
 * Watcher & Hooks tools — inspect watcher status, list presets, view hooks config,
 * check notification setup, test notifications, configure alerts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import audit from '../safety/audit.js';
import persistAlerts from '../services/alerts-config.js';
import type HooksService from '../services/hooks.service.js';
import NotifierService from '../services/notifier.service.js';
import { listPresets as listAllPresets } from '../services/presets.js';
import type WatcherService from '../services/watcher.service.js';
import type { AlertsConfig } from '../types/index.js';

/** Chat webhooks carry their credential in the path, so the audit log keeps the origin only. */
function webhookOrigin(url: string): string {
  if (url === '') return '';
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? '[not an http(s) URL]' : origin;
  } catch {
    return '[invalid URL]';
  }
}

interface ConfigureAlertsArgs {
  desktop?: boolean;
  sound?: boolean;
  urgency_threshold?: AlertsConfig['urgencyThreshold'];
  webhook_url?: string;
  webhook_events?: AlertsConfig['webhookEvents'];
}

/** The settings a configure_alerts call sets; an omitted field stays as it is. */
function alertsPatch(args: ConfigureAlertsArgs): Partial<AlertsConfig> {
  const partial: Partial<AlertsConfig> = {};
  if (args.desktop !== undefined) partial.desktop = args.desktop;
  if (args.sound !== undefined) partial.sound = args.sound;
  if (args.urgency_threshold !== undefined) partial.urgencyThreshold = args.urgency_threshold;
  if (args.webhook_url !== undefined) partial.webhookUrl = args.webhook_url;
  if (args.webhook_events !== undefined) partial.webhookEvents = args.webhook_events;
  return partial;
}

function currentAlertsText(current: AlertsConfig): string {
  return (
    `No changes specified. Current config:\n` +
    `  Desktop:   ${current.desktop ? '✅' : '❌'}\n` +
    `  Sound:     ${current.sound ? '✅' : '❌'}\n` +
    `  Threshold: ${current.urgencyThreshold}\n` +
    `  Webhook:   ${current.webhookUrl || '(none)'}\n` +
    `  Events:    ${current.webhookEvents.join(', ')}`
  );
}

function updatedAlertsText(updated: AlertsConfig, saveNote: string): string {
  return [
    '✅ Alerts configuration updated:',
    `   Desktop:   ${updated.desktop ? '✅ enabled' : '❌ disabled'}`,
    `   Sound:     ${updated.sound ? '✅ enabled' : '❌ disabled'}`,
    `   Threshold: ${updated.urgencyThreshold}`,
    `   Webhook:   ${updated.webhookUrl || '(none)'}`,
    `   Events:    ${updated.webhookEvents.join(', ')}`,
    saveNote,
  ].join('\n');
}

/** A failed save leaves the new settings active for this session only. */
async function saveAlertsToConfig(
  updated: AlertsConfig,
): Promise<{ note: string; error?: string }> {
  try {
    await persistAlerts(updated);
    return { note: '\n\n💾 Changes saved to config file.' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      note: `\n\n⚠️ Could not save to config file: ${error}\n   Changes are active for this session only.`,
      error,
    };
  }
}

function alertsAuditParams(partial: Partial<AlertsConfig>, save: boolean): Record<string, unknown> {
  const params: Record<string, unknown> = { ...partial, save };
  if (partial.webhookUrl !== undefined) params.webhookUrl = webhookOrigin(partial.webhookUrl);
  return params;
}

async function auditAlertsChange(
  params: Record<string, unknown>,
  saveError: string | undefined,
): Promise<void> {
  await audit.log(
    'configure_alerts',
    'system',
    params,
    saveError === undefined ? 'ok' : 'error',
    saveError === undefined ? undefined : `Not saved: ${saveError}`,
  );
}

/** Validation errors quote the URL they refused; the entry keeps its origin only. */
async function auditAlertsRefusal(
  params: Record<string, unknown>,
  errMsg: string,
  webhookUrl: string | undefined,
): Promise<void> {
  const error = webhookUrl ? errMsg.replaceAll(webhookUrl, webhookOrigin(webhookUrl)) : errMsg;
  await audit.log('configure_alerts', 'system', params, 'error', error);
}

export function registerWatcherReadTools(
  server: McpServer,
  watcherService: WatcherService,
  hooksService: HooksService,
): void {
  const hooksConfig = hooksService.getHooksConfig();
  // -------------------------------------------------------------------------
  // get_watcher_status — read
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_watcher_status',
    {
      title: 'Get Watcher Status',
      description: 'Get the status of IMAP IDLE watcher connections and recent activity.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const status = watcherService.getStatus();

      if (status.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Watcher is not active. Enable it in config: [settings.watcher] enabled = true',
            },
          ],
        };
      }

      const lines = status.map((s) => {
        const icon = s.connected ? '🟢 connected' : '🔴 disconnected';
        return `• ${s.account}/${s.folder}: ${icon} (last UID: ${s.lastSeenUid})`;
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `📡 Watcher Status (${status.length} connection(s)):\n${lines.join('\n')}`,
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // list_presets — read
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_presets',
    {
      title: 'List Triage Presets',
      description:
        'List all available AI triage presets with their descriptions and suggested labels.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const presets = listAllPresets();
      const activePreset = hooksConfig.preset;

      const lines = presets.map((p) => {
        const active = p.id === activePreset ? ' ✅ (active)' : '';
        const labels =
          p.suggestedLabels.length > 0 ? `\n     Labels: ${p.suggestedLabels.join(', ')}` : '';
        return `• ${p.name} [${p.id}]${active}\n     ${p.description}${labels}`;
      });

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `🎯 Available Hook Presets:\n\n${lines.join('\n\n')}` +
              `\n\nTo change preset, set \`preset = "${activePreset}"\` in [settings.hooks] of your config.toml.`,
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // get_hooks_config — read
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_hooks_config',
    {
      title: 'Get Hooks Configuration',
      description:
        'Get the current AI hooks configuration including preset, rules, and custom instructions.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const sections: string[] = [
        `⚙️  Hooks Configuration:`,
        `   Mode:     ${hooksConfig.onNewEmail}`,
        `   Preset:   ${hooksConfig.preset}`,
        `   Labels:   ${hooksConfig.autoLabel ? 'auto-apply' : 'disabled'}`,
        `   Flags:    ${hooksConfig.autoFlag ? 'auto-flag' : 'disabled'}`,
        `   Batch:    ${hooksConfig.batchDelay}s delay`,
      ];

      if (hooksConfig.customInstructions) {
        sections.push(
          `\n📝 Custom Instructions:\n   ${hooksConfig.customInstructions.replace(/\n/g, '\n   ')}`,
        );
      }

      if (hooksConfig.rules.length > 0) {
        sections.push(`\n📋 Static Rules (${hooksConfig.rules.length}):`);
        hooksConfig.rules.forEach((rule) => {
          const matchParts: string[] = [];
          if (rule.match.from) matchParts.push(`from=${rule.match.from}`);
          if (rule.match.to) matchParts.push(`to=${rule.match.to}`);
          if (rule.match.subject) matchParts.push(`subject=${rule.match.subject}`);

          const actionParts: string[] = [];
          if (rule.actions.labels?.length) {
            actionParts.push(`labels=[${rule.actions.labels.join(', ')}]`);
          }
          if (rule.actions.flag) actionParts.push('flag');
          if (rule.actions.markRead) actionParts.push('mark_read');
          if (rule.actions.alert) actionParts.push('🔔 alert');

          sections.push(
            `   • "${rule.name}": ${matchParts.join(' & ')} → ${actionParts.join(', ')}`,
          );
        });
      } else {
        sections.push('\n📋 Static Rules: none configured');
      }

      // Alerts config
      const { alerts } = hooksConfig;
      sections.push(`\n🔔 Alerts:`);
      sections.push(`   Desktop:   ${alerts.desktop ? '✅ enabled' : '❌ disabled'}`);
      sections.push(`   Sound:     ${alerts.sound ? '✅ enabled' : '❌ disabled'}`);
      sections.push(`   Threshold: ${alerts.urgencyThreshold}`);
      if (alerts.webhookUrl) {
        sections.push(`   Webhook:   ${alerts.webhookUrl}`);
        sections.push(`   Events:    ${alerts.webhookEvents.join(', ')}`);
      } else {
        sections.push(`   Webhook:   not configured`);
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // check_notification_setup — diagnose platform support
  // -------------------------------------------------------------------------

  server.registerTool(
    'check_notification_setup',
    {
      title: 'Check Notification Setup',
      description:
        'Diagnose desktop notification support on this platform. ' +
        'Checks if required OS tools are available and provides setup instructions ' +
        'to enable notification permissions (macOS, Linux, Windows).',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const diag = await NotifierService.checkPlatformSupport();
      const notifier = hooksService.getNotifier();
      const alertsCfg = notifier.getConfig();

      const lines: string[] = [
        `🔍 Notification Setup Diagnostics`,
        ``,
        `Platform:    ${diag.platform}`,
        `Desktop:     ${diag.desktopTool.name} — ${diag.desktopTool.available ? '✅ available' : '❌ not found'}`,
        `Sound:       ${diag.soundTool.name} — ${diag.soundTool.available ? '✅ available' : '❌ not found'}`,
        `Supported:   ${diag.supported ? '✅ yes' : '❌ no'}`,
      ];

      if (diag.issues.length > 0) {
        lines.push('', '⚠️  Issues:');
        diag.issues.forEach((issue: string) => {
          lines.push(`   • ${issue}`);
        });
      }

      lines.push('', '📋 Setup Instructions:');
      diag.setupInstructions.forEach((instr: string) => {
        lines.push(`   ${instr}`);
      });

      lines.push(
        '',
        '⚙️  Current Config:',
        `   Desktop:   ${alertsCfg.desktop ? '✅ enabled' : '❌ disabled'}`,
        `   Sound:     ${alertsCfg.sound ? '✅ enabled' : '❌ disabled'}`,
        `   Threshold: ${alertsCfg.urgencyThreshold}`,
        alertsCfg.webhookUrl
          ? `   Webhook:   ${alertsCfg.webhookUrl}`
          : '   Webhook:   not configured',
      );

      if (!alertsCfg.desktop && diag.supported) {
        lines.push(
          '',
          '💡 Tip: Desktop notifications are supported but disabled.',
          '   Use configure_alerts to enable them, or set desktop = true in config.toml.',
        );
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}

export function registerWatcherWriteTools(server: McpServer, hooksService: HooksService): void {
  const hooksConfig = hooksService.getHooksConfig();

  // -------------------------------------------------------------------------
  // test_notification — send a test notification
  // -------------------------------------------------------------------------

  server.registerTool(
    'test_notification',
    {
      title: 'Send Test Notification',
      description:
        'Send a test desktop notification to verify that OS permissions are correctly configured. ' +
        'Use check_notification_setup first to diagnose any issues.',
      inputSchema: {
        sound: z
          .boolean()
          .default(false)
          .describe('Include a sound alert in the test notification'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ sound }) => {
      const notifier = hooksService.getNotifier();
      const result = await notifier.sendTestNotification(sound);

      const icon = result.success ? '✅' : '❌';
      const lines = [`${icon} ${result.message}`];

      if (!result.success) {
        const diag = await NotifierService.checkPlatformSupport();
        lines.push('', '🔧 Troubleshooting:');
        diag.setupInstructions.forEach((instr: string) => {
          lines.push(`   ${instr}`);
        });
      }

      return {
        ...(result.success ? {} : { isError: true as const }),
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // configure_alerts — runtime alert configuration
  // -------------------------------------------------------------------------

  server.registerTool(
    'configure_alerts',
    {
      title: 'Configure Alerts',
      description:
        'Update alert/notification settings at runtime. Changes take effect immediately. ' +
        'Use save=true to persist changes to the config file. ' +
        'Omit any field to leave it unchanged.',
      inputSchema: {
        desktop: z.boolean().optional().describe('Enable/disable desktop notifications'),
        sound: z.boolean().optional().describe('Enable/disable sound alerts for urgent emails'),
        urgency_threshold: z
          .enum(['urgent', 'high', 'normal', 'low'])
          .optional()
          .describe('Minimum urgency level to trigger desktop notifications'),
        webhook_url: z
          .string()
          .optional()
          .describe('Webhook URL for external notifications (empty string to disable)'),
        webhook_events: z
          .array(z.enum(['urgent', 'high', 'normal', 'low']))
          .optional()
          .describe('Which urgency levels trigger webhook dispatch'),
        save: z
          .boolean()
          .default(false)
          .describe('Persist changes to config.toml (default: runtime only)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const notifier = hooksService.getNotifier();
      const partial = alertsPatch(args);
      if (Object.keys(partial).length === 0) {
        return {
          content: [{ type: 'text' as const, text: currentAlertsText(notifier.getConfig()) }],
        };
      }

      const auditParams = alertsAuditParams(partial, args.save);
      try {
        const updated = notifier.updateConfig(partial);
        hooksConfig.alerts = { ...updated };
        const saved = args.save ? await saveAlertsToConfig(updated) : { note: '' };
        await auditAlertsChange(auditParams, saved.error);
        return {
          content: [{ type: 'text' as const, text: updatedAlertsText(updated, saved.note) }],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await auditAlertsRefusal(auditParams, errMsg, args.webhook_url);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to update alerts config: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
