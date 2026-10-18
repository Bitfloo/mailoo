import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import audit from '../safety/audit.js';
import type { AppConfig } from '../types/index.js';
import registerAllTools from './register.js';

// Mock ALL tool registration imports
vi.mock('./accounts.tool.js', () => ({ default: vi.fn() }));
vi.mock('./analytics.tool.js', () => ({ default: vi.fn() }));
vi.mock('./attachments.tool.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, default: vi.fn() };
});
vi.mock('./bulk.tool.js', () => ({ default: vi.fn() }));
vi.mock('./calendar.tool.js', () => ({
  registerCalendarReadTools: vi.fn(),
  registerCalendarWriteTools: vi.fn(),
}));
vi.mock('./contacts.tool.js', () => ({ default: vi.fn() }));
vi.mock('./drafts.tool.js', () => ({ default: vi.fn() }));
vi.mock('./emails.tool.js', () => ({ default: vi.fn() }));
vi.mock('./export.tool.js', () => ({ default: vi.fn() }));
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
import registerAnalyticsTools from './analytics.tool.js';
import registerAttachmentTools from './attachments.tool.js';
import registerBulkTools from './bulk.tool.js';
import { registerCalendarReadTools, registerCalendarWriteTools } from './calendar.tool.js';
import registerContactsTools from './contacts.tool.js';
import registerDraftTools from './drafts.tool.js';
import registerEmailsTools from './emails.tool.js';
import registerExportTools from './export.tool.js';
import registerFolderTools from './folders.tool.js';
import registerHealthTools from './health.tool.js';
import { registerLabelReadTools, registerLabelWriteTools } from './label.tool.js';
import registerLocateTools from './locate.tool.js';
import registerMailboxesTools from './mailboxes.tool.js';
import registerManageTools from './manage.tool.js';
import { registerSchedulerReadTools, registerSchedulerWriteTools } from './scheduler.tool.js';
import registerSecurityTools from './security.tool.js';
import registerSendTools from './send.tool.js';
import { registerSieveReadTools, registerSieveWriteTools } from './sieve.tool.js';
import { registerTemplateReadTools, registerTemplateWriteTools } from './templates.tool.js';
import registerThreadTools from './thread.tool.js';
import { registerWatcherReadTools, registerWatcherWriteTools } from './watcher.tool.js';

function createConfig(readOnly: boolean, toolset: 'full' | 'core' | 'minimal' = 'full'): AppConfig {
  return {
    settings: {
      rateLimit: 10,
      readOnly,
      toolset,
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

  // Tools audit the account argument as given; the entry must name the account the connections used.
  it('resolves audited account names through the connections it registers tools with', () => {
    const setResolver = vi.spyOn(audit, 'setAccountResolver');
    const connections = { resolveAccountName: vi.fn().mockReturnValue('work') };
    registerAllTools(
      {} as never,
      connections as never,
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
    const [resolver] = setResolver.mock.calls[0] ?? [];
    expect(resolver?.('Work@Example.com')).toBe('work');
    expect(connections.resolveAccountName).toHaveBeenCalledWith('Work@Example.com');
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
    expect(registerExportTools).toHaveBeenCalledWith({}, {}, false);
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
    // read_only reaches the tool, which then rejects savePath.
    expect(registerExportTools).toHaveBeenCalledWith({}, {}, true);
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

  it('registers only core email, thread, draft, bulk, attachment, and health modules when toolset is core', () => {
    registerAllTools(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createConfig(false, 'core'),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    expect(registerAccountsTools).toHaveBeenCalled();
    expect(registerMailboxesTools).toHaveBeenCalled();
    expect(registerEmailsTools).toHaveBeenCalled();
    expect(registerThreadTools).toHaveBeenCalled();
    expect(registerSendTools).toHaveBeenCalled();
    expect(registerDraftTools).toHaveBeenCalled();
    expect(registerManageTools).toHaveBeenCalled();
    expect(registerBulkTools).toHaveBeenCalled();
    expect(registerAttachmentTools).toHaveBeenCalled();
    expect(registerHealthTools).toHaveBeenCalled();

    expect(registerExportTools).not.toHaveBeenCalled();
    expect(registerCalendarReadTools).not.toHaveBeenCalled();
    expect(registerCalendarWriteTools).not.toHaveBeenCalled();
    expect(registerSieveReadTools).not.toHaveBeenCalled();
    expect(registerSieveWriteTools).not.toHaveBeenCalled();
    expect(registerSchedulerReadTools).not.toHaveBeenCalled();
    expect(registerSchedulerWriteTools).not.toHaveBeenCalled();
  });

  it('registers only minimal modules when toolset is minimal', () => {
    registerAllTools(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      createConfig(false, 'minimal'),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    expect(registerAccountsTools).toHaveBeenCalled();
    expect(registerMailboxesTools).toHaveBeenCalled();
    expect(registerEmailsTools).toHaveBeenCalled();
    expect(registerSendTools).toHaveBeenCalled();
    expect(registerManageTools).toHaveBeenCalled();
    expect(registerHealthTools).toHaveBeenCalled();

    expect(registerThreadTools).not.toHaveBeenCalled();
    expect(registerDraftTools).not.toHaveBeenCalled();
    expect(registerBulkTools).not.toHaveBeenCalled();
    expect(registerAttachmentTools).not.toHaveBeenCalled();
    expect(registerExportTools).not.toHaveBeenCalled();
  });

  it('keeps toolset profile counts in sync across registerAllTools, README.md, docs/configuration.md, and docs/assets/mailoo-architecture.svg', async () => {
    const [
      accountsActual,
      analyticsActual,
      attachmentsActual,
      bulkActual,
      calendarActual,
      contactsActual,
      draftsActual,
      emailsActual,
      exportActual,
      foldersActual,
      healthActual,
      labelActual,
      locateActual,
      mailboxesActual,
      manageActual,
      schedulerActual,
      securityActual,
      sendActual,
      sieveActual,
      templatesActual,
      threadActual,
      watcherActual,
    ] = await Promise.all([
      vi.importActual<{ default: typeof registerAccountsTools }>('./accounts.tool.js'),
      vi.importActual<{ default: typeof registerAnalyticsTools }>('./analytics.tool.js'),
      vi.importActual<{ default: typeof registerAttachmentTools }>('./attachments.tool.js'),
      vi.importActual<{ default: typeof registerBulkTools }>('./bulk.tool.js'),
      vi.importActual<{
        registerCalendarReadTools: typeof registerCalendarReadTools;
        registerCalendarWriteTools: typeof registerCalendarWriteTools;
      }>('./calendar.tool.js'),
      vi.importActual<{ default: typeof registerContactsTools }>('./contacts.tool.js'),
      vi.importActual<{ default: typeof registerDraftTools }>('./drafts.tool.js'),
      vi.importActual<{ default: typeof registerEmailsTools }>('./emails.tool.js'),
      vi.importActual<{ default: typeof registerExportTools }>('./export.tool.js'),
      vi.importActual<{ default: typeof registerFolderTools }>('./folders.tool.js'),
      vi.importActual<{ default: typeof registerHealthTools }>('./health.tool.js'),
      vi.importActual<{
        registerLabelReadTools: typeof registerLabelReadTools;
        registerLabelWriteTools: typeof registerLabelWriteTools;
      }>('./label.tool.js'),
      vi.importActual<{ default: typeof registerLocateTools }>('./locate.tool.js'),
      vi.importActual<{ default: typeof registerMailboxesTools }>('./mailboxes.tool.js'),
      vi.importActual<{ default: typeof registerManageTools }>('./manage.tool.js'),
      vi.importActual<{
        registerSchedulerReadTools: typeof registerSchedulerReadTools;
        registerSchedulerWriteTools: typeof registerSchedulerWriteTools;
      }>('./scheduler.tool.js'),
      vi.importActual<{ default: typeof registerSecurityTools }>('./security.tool.js'),
      vi.importActual<{ default: typeof registerSendTools }>('./send.tool.js'),
      vi.importActual<{
        registerSieveReadTools: typeof registerSieveReadTools;
        registerSieveWriteTools: typeof registerSieveWriteTools;
      }>('./sieve.tool.js'),
      vi.importActual<{
        registerTemplateReadTools: typeof registerTemplateReadTools;
        registerTemplateWriteTools: typeof registerTemplateWriteTools;
      }>('./templates.tool.js'),
      vi.importActual<{ default: typeof registerThreadTools }>('./thread.tool.js'),
      vi.importActual<{
        registerWatcherReadTools: typeof registerWatcherReadTools;
        registerWatcherWriteTools: typeof registerWatcherWriteTools;
      }>('./watcher.tool.js'),
    ]);

    vi.mocked(registerAccountsTools).mockImplementation(accountsActual.default);
    vi.mocked(registerAnalyticsTools).mockImplementation(analyticsActual.default);
    vi.mocked(registerAttachmentTools).mockImplementation(attachmentsActual.default);
    vi.mocked(registerBulkTools).mockImplementation(bulkActual.default);
    vi.mocked(registerCalendarReadTools).mockImplementation(
      calendarActual.registerCalendarReadTools,
    );
    vi.mocked(registerCalendarWriteTools).mockImplementation(
      calendarActual.registerCalendarWriteTools,
    );
    vi.mocked(registerContactsTools).mockImplementation(contactsActual.default);
    vi.mocked(registerDraftTools).mockImplementation(draftsActual.default);
    vi.mocked(registerEmailsTools).mockImplementation(emailsActual.default);
    vi.mocked(registerExportTools).mockImplementation(exportActual.default);
    vi.mocked(registerFolderTools).mockImplementation(foldersActual.default);
    vi.mocked(registerHealthTools).mockImplementation(healthActual.default);
    vi.mocked(registerLabelReadTools).mockImplementation(labelActual.registerLabelReadTools);
    vi.mocked(registerLabelWriteTools).mockImplementation(labelActual.registerLabelWriteTools);
    vi.mocked(registerLocateTools).mockImplementation(locateActual.default);
    vi.mocked(registerMailboxesTools).mockImplementation(mailboxesActual.default);
    vi.mocked(registerManageTools).mockImplementation(manageActual.default);
    vi.mocked(registerSchedulerReadTools).mockImplementation(
      schedulerActual.registerSchedulerReadTools,
    );
    vi.mocked(registerSchedulerWriteTools).mockImplementation(
      schedulerActual.registerSchedulerWriteTools,
    );
    vi.mocked(registerSecurityTools).mockImplementation(securityActual.default);
    vi.mocked(registerSendTools).mockImplementation(sendActual.default);
    vi.mocked(registerSieveReadTools).mockImplementation(sieveActual.registerSieveReadTools);
    vi.mocked(registerSieveWriteTools).mockImplementation(sieveActual.registerSieveWriteTools);
    vi.mocked(registerTemplateReadTools).mockImplementation(
      templatesActual.registerTemplateReadTools,
    );
    vi.mocked(registerTemplateWriteTools).mockImplementation(
      templatesActual.registerTemplateWriteTools,
    );
    vi.mocked(registerThreadTools).mockImplementation(threadActual.default);
    vi.mocked(registerWatcherReadTools).mockImplementation(watcherActual.registerWatcherReadTools);
    vi.mocked(registerWatcherWriteTools).mockImplementation(
      watcherActual.registerWatcherWriteTools,
    );

    const countRegistered = (toolset: 'full' | 'core' | 'minimal', readOnly: boolean): number => {
      let count = 0;
      const serverStub = {
        registerTool: () => {
          count += 1;
        },
      };
      const hooksStub = {
        getHooksConfig: () => createConfig(readOnly, toolset).settings.hooks,
      };
      registerAllTools(
        serverStub as never,
        {} as never,
        {} as never,
        {} as never,
        createConfig(readOnly, toolset),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        hooksStub as never,
      );
      return count;
    };

    try {
      const counts = {
        full: {
          readWrite: countRegistered('full', false),
          readOnly: countRegistered('full', true),
        },
        core: {
          readWrite: countRegistered('core', false),
          readOnly: countRegistered('core', true),
        },
        minimal: {
          readWrite: countRegistered('minimal', false),
          readOnly: countRegistered('minimal', true),
        },
      };

      expect(counts).toEqual({
        full: { readWrite: 57, readOnly: 31 },
        core: { readWrite: 19, readOnly: 10 },
        minimal: { readWrite: 14, readOnly: 8 },
      });

      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
      const [readme, configDoc, architectureSvg] = await Promise.all([
        readFile(join(repoRoot, 'README.md'), 'utf8'),
        readFile(join(repoRoot, 'docs', 'configuration.md'), 'utf8'),
        readFile(join(repoRoot, 'docs', 'assets', 'mailoo-architecture.svg'), 'utf8'),
      ]);

      expect(readme).toContain(`exposing only the ${counts.full.readOnly} read-only tools.`);
      expect(readme).toContain(
        `\`full\` *(default)* — All **${counts.full.readWrite} tools** (**${counts.full.readOnly}** in \`read_only\` mode)`,
      );
      expect(readme).toContain(
        `\`core\` — **${counts.core.readWrite} tools** (**${counts.core.readOnly}** in \`read_only\` mode)`,
      );
      expect(readme).toContain(
        `\`minimal\` — **${counts.minimal.readWrite} tools** (**${counts.minimal.readOnly}** in \`read_only\` mode)`,
      );

      const lead = 'The registered tools are exactly:';
      const at = configDoc.indexOf(lead);
      expect(at).toBeGreaterThanOrEqual(0);
      const rest = configDoc.slice(at + lead.length).replace(/^\s+/, '');
      const paragraphEnd = rest.search(/\n[ \t]*\n/);
      const documentedReadOnlyTools = [...rest.slice(0, paragraphEnd).matchAll(/`([^`]+)`/g)].map(
        (m) => m[1],
      );
      expect(documentedReadOnlyTools).toHaveLength(counts.full.readOnly);

      expect(architectureSvg).toContain(`Frontier Agents (Full ${counts.full.readWrite})`);
      expect(architectureSvg).toContain(
        `Toolsets: full (${counts.full.readWrite}/${counts.full.readOnly}) | core (${counts.core.readWrite}/${counts.core.readOnly}) | minimal (${counts.minimal.readWrite}/${counts.minimal.readOnly})`,
      );
    } finally {
      vi.resetAllMocks();
    }
  });
});
