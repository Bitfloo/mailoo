/** Shared fixtures for the watcher tool unit suites. */

import type HooksService from '../services/hooks.service.js';
import type NotifierService from '../services/notifier.service.js';
import { registerWatcherWriteTools } from '../tools/watcher.tool.js';
import type { HooksConfig } from '../types/index.js';

export type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { type: string; text: string }[];
}>;

export function hooksConfigFor(notifier: NotifierService): HooksConfig {
  return {
    onNewEmail: 'notify' as const,
    preset: 'priority-focus' as const,
    autoLabel: false,
    autoFlag: false,
    batchDelay: 5,
    rules: [],
    alerts: notifier.getConfig(),
  };
}

export function captureConfigureAlerts(
  notifier: NotifierService,
  hooksConfig = hooksConfigFor(notifier),
): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool: (name: string, _config: unknown, fn: Handler) => {
      if (name === 'configure_alerts') handler = fn;
    },
  };
  registerWatcherWriteTools(
    server as never,
    {
      getHooksConfig: () => hooksConfig,
      getNotifier: () => notifier,
    } as unknown as HooksService,
  );
  if (!handler) throw new Error('configure_alerts handler was not registered');
  return handler;
}
