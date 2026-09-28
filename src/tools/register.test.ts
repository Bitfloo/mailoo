import type { AppConfig } from '../types/index.js';
import registerAllTools from './register.js';

// Mock ALL tool registration imports
vi.mock('./accounts.tool.js', () => ({ default: vi.fn() }));
vi.mock('./analytics.tool.js', () => ({ default: vi.fn() }));
vi.mock('./attachments.tool.js', () => ({ default: vi.fn() }));
vi.mock('./bulk.tool.js', () => ({ default: vi.fn() }));
vi.mock('./calendar.tool.js', () => ({
  registerCalendarReadTools: vi.fn(),
  registerCalendarWriteTools: vi.fn(),
}));
vi.mock('./contacts.tool.js', () => ({ default: vi.fn() }));
vi.mock('./drafts.tool.js', () => ({ default: vi.fn() }));
vi.mock('./emails.tool.js', () => ({ default: vi.fn() }));
vi.mock('./folders.tool.js', () => ({ default: vi.fn() }));
vi.mock('./health.tool.js', () => ({ default: vi.fn() }));
vi.mock('./label.tool.js', () => ({
  registerLabelReadTools: vi.fn(),
  registerLabelWriteTools: vi.fn(),
}));
vi.mock('./locate.tool.js', () => ({ default: vi.fn() }));
vi.mock('./mailboxes.tool.js', () => ({ default: vi.fn() }));
vi.mock('./manage.tool.js', () => ({ default: vi.fn() }));
vi.mock('./scheduler.tool.js', () => ({
  registerSchedulerReadTools: vi.fn(),
  registerSchedulerWriteTools: vi.fn(),
}));
vi.mock('./security.tool.js', () => ({ default: vi.fn() }));
vi.mock('./send.tool.js', () => ({ default: vi.fn() }));
vi.mock('./sieve.tool.js', () => ({
  registerSieveReadTools: vi.fn(),
  registerSieveWriteTools: vi.fn(),
}));
vi.mock('./templates.tool.js', () => ({
  registerTemplateReadTools: vi.fn(),
  registerTemplateWriteTools: vi.fn(),
}));
vi.mock('./thread.tool.js', () => ({ default: vi.fn() }));
vi.mock('./watcher.tool.js', () => ({
  registerWatcherReadTools: vi.fn(),
  registerWatcherWriteTools: vi.fn(),
}));

import registerAccountsTools from './accounts.tool.js';
import registerBulkTools from './bulk.tool.js';
import { registerCalendarReadTools, registerCalendarWriteTools } from './calendar.tool.js';
import registerDraftTools from './drafts.tool.js';
import registerEmailsTools from './emails.tool.js';
import registerFolderTools from './folders.tool.js';
import { registerLabelReadTools, registerLabelWriteTools } from './label.tool.js';
import registerManageTools from './manage.tool.js';
import { registerSchedulerReadTools, registerSchedulerWriteTools } from './scheduler.tool.js';
import registerSecurityTools from './security.tool.js';
import registerSendTools from './send.tool.js';
import { registerSieveReadTools, registerSieveWriteTools } from './sieve.tool.js';
import { registerTemplateWriteTools } from './templates.tool.js';
import { registerWatcherReadTools, registerWatcherWriteTools } from './watcher.tool.js';

function createConfig(readOnly: boolean): AppConfig {
  return {
    settings: {
      rateLimit: 10,
      readOnly,
      saveToSent: true,
      watcher: { enabled: false, folders: ['INBOX'], idleTimeout: 1740 },
      systemOne: {
        enabled: false,
        model: 'jev-latest',
        includeBody: false,
        bodyMaxChars: 6000,
        autoMove: false,
        autoFlag: false,
        folders: [],
        sourceFolders: ['INBOX'],
        thresholds: {
          folderFitMin: 0.85,
          spamHigh: 0.72,
          spamUncertainLow: 0.4,
          spamUncertainHigh: 0.6,
          injectionHigh: 0.75,
          importanceFlagMin: 3,
          importanceMinConfidence: 0.7,
          isCriticalMin: 0.85,
        },
      },
      hooks: {
        onNewEmail: 'notify',
        preset: 'priority-focus',
        autoLabel: false,
        autoFlag: false,
        batchDelay: 5,
        rules: [],
        alerts: {
          desktop: false,
          sound: false,
          urgencyThreshold: 'high',
          webhookUrl: '',
          webhookEvents: ['urgent', 'high'],
        },
      },
    },
    accounts: [],
  };
}

describe('registerAllTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all tools when readOnly is false', () => {
    registerAllTools(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createConfig(false),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    // Read tools should always be registered
    expect(registerAccountsTools).toHaveBeenCalled();
    expect(registerEmailsTools).toHaveBeenCalled();
    expect(registerSecurityTools).toHaveBeenCalled();
    expect(registerSieveReadTools).toHaveBeenCalled();
    expect(registerCalendarReadTools).toHaveBeenCalled();
    expect(registerCalendarWriteTools).toHaveBeenCalled();
    expect(registerWatcherReadTools).toHaveBeenCalled();
    expect(registerLabelReadTools).toHaveBeenCalled();
    expect(registerSchedulerReadTools).toHaveBeenCalled();
    expect(registerSchedulerWriteTools).toHaveBeenCalled();
    // Write tools should be registered when NOT read-only
    expect(registerSendTools).toHaveBeenCalled();
    expect(registerManageTools).toHaveBeenCalled();
    expect(registerLabelWriteTools).toHaveBeenCalled();
    expect(registerBulkTools).toHaveBeenCalled();
    expect(registerDraftTools).toHaveBeenCalled();
    expect(registerFolderTools).toHaveBeenCalled();
    expect(registerTemplateWriteTools).toHaveBeenCalled();
    expect(registerWatcherWriteTools).toHaveBeenCalled();
    expect(registerSieveWriteTools).toHaveBeenCalled();
  });

  it('skips write tools when readOnly is true', () => {
    registerAllTools(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createConfig(true),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    // Read tools should still be registered
    expect(registerAccountsTools).toHaveBeenCalled();
    expect(registerEmailsTools).toHaveBeenCalled();
    expect(registerSecurityTools).toHaveBeenCalled();
    expect(registerSieveReadTools).toHaveBeenCalled();
    expect(registerCalendarReadTools).toHaveBeenCalled();
    expect(registerWatcherReadTools).toHaveBeenCalled();
    expect(registerLabelReadTools).toHaveBeenCalled();
    expect(registerSchedulerReadTools).toHaveBeenCalled();
    // Write tools should NOT be registered
    expect(registerSendTools).not.toHaveBeenCalled();
    expect(registerManageTools).not.toHaveBeenCalled();
    expect(registerLabelWriteTools).not.toHaveBeenCalled();
    expect(registerBulkTools).not.toHaveBeenCalled();
    expect(registerDraftTools).not.toHaveBeenCalled();
    expect(registerFolderTools).not.toHaveBeenCalled();
    expect(registerTemplateWriteTools).not.toHaveBeenCalled();
    expect(registerSchedulerWriteTools).not.toHaveBeenCalled();
    expect(registerCalendarWriteTools).not.toHaveBeenCalled();
    expect(registerWatcherWriteTools).not.toHaveBeenCalled();
    expect(registerSieveWriteTools).not.toHaveBeenCalled();
  });
});
