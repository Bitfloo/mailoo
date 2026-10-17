/**
 * Persists runtime alert settings to config.toml, keeping every other setting.
 */

import { loadRawConfig, saveConfig } from '../config/loader.js';
import type { AlertsConfig } from '../types/index.js';

export default async function persistAlerts(
  alerts: AlertsConfig,
  configPath?: string,
): Promise<void> {
  const rawConfig = await loadRawConfig(configPath);
  rawConfig.settings.hooks.alerts = {
    ...rawConfig.settings.hooks.alerts,
    desktop: alerts.desktop,
    sound: alerts.sound,
    urgency_threshold: alerts.urgencyThreshold,
    webhook_url: alerts.webhookUrl,
    webhook_events: alerts.webhookEvents,
  };
  await saveConfig(rawConfig, configPath);
}
