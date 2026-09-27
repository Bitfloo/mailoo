/**
 * tools/list is the client-visible hint contract. A missing hint is not an
 * explicit false: the protocol default differs for each hint.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import registerAllPrompts from '../prompts/register.js';
import registerAllResources from '../resources/register.js';
import createServer from '../server.js';
import type { AppConfig } from '../types/index.js';
import registerAllTools from './register.js';

const HINT_KEYS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

type HintKey = (typeof HINT_KEYS)[number];
type ToolHints = Record<HintKey, boolean>;

/** Argument order is readOnlyHint, destructiveHint, idempotentHint, openWorldHint. */
function hints(
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
  openWorldHint: boolean,
): ToolHints {
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint };
}

const EXPECTED_TOOL_ANNOTATIONS = {
  list_accounts: hints(true, false, true, false),
  list_mailboxes: hints(true, false, true, true),
  list_emails: hints(true, false, true, true),
  get_email: hints(false, false, true, true),
  get_emails: hints(true, false, true, true),
  get_email_status: hints(true, false, true, true),
  search_emails: hints(true, false, true, true),
  download_attachment: hints(false, true, true, true),
  extract_contacts: hints(true, false, true, true),
  get_thread: hints(true, false, true, true),
  list_templates: hints(true, false, true, false),
  extract_calendar: hints(true, false, true, true),
  add_to_calendar: hints(false, false, false, true),
  check_calendar_permissions: hints(true, false, true, false),
  list_calendars: hints(true, false, true, false),
  list_events: hints(true, false, true, false),
  list_reminders: hints(true, false, true, false),
  create_reminder: hints(false, false, false, true),
  analyze_email_for_scheduling: hints(true, false, true, true),
  get_email_stats: hints(true, false, true, true),
  check_health: hints(true, false, true, true),
  find_email_folder: hints(true, false, true, true),
  get_watcher_status: hints(true, false, true, false),
  list_presets: hints(true, false, true, false),
  get_hooks_config: hints(true, false, true, false),
  check_notification_setup: hints(true, false, true, false),
  test_notification: hints(false, false, false, false),
  configure_alerts: hints(false, true, true, true),
  get_email_security: hints(true, false, true, true),
  sieve_status: hints(true, false, true, true),
  sieve_list_scripts: hints(true, false, true, true),
  sieve_get_script: hints(true, false, true, true),
  send_email: hints(false, true, false, true),
  reply_email: hints(false, true, false, true),
  forward_email: hints(false, true, false, true),
  move_email: hints(false, false, true, true),
  delete_email: hints(false, true, true, true),
  mark_email: hints(false, false, true, true),
  list_labels: hints(true, false, true, true),
  add_label: hints(false, false, true, true),
  remove_label: hints(false, true, true, true),
  create_label: hints(false, false, true, true),
  delete_label: hints(false, true, true, true),
  bulk_action: hints(false, true, true, true),
  save_draft: hints(false, false, false, true),
  send_draft: hints(false, true, false, true),
  create_mailbox: hints(false, false, true, true),
  rename_mailbox: hints(false, false, true, true),
  delete_mailbox: hints(false, true, true, true),
  apply_template: hints(false, true, false, true),
  schedule_email: hints(false, true, false, true),
  list_scheduled: hints(true, false, true, false),
  cancel_scheduled: hints(false, true, true, true),
  sieve_put_script: hints(false, true, true, true),
  sieve_delete_script: hints(false, true, true, true),
  sieve_activate_script: hints(false, true, true, true),
} satisfies Record<string, ToolHints>;

/**
 * registerAllTools still skips write modules as a group. A writable tool in a
 * read module stays listed, and a read-only tool in a write module stays
 * hidden. These names are that gap, not a silent skip.
 */
const READ_ONLY_EXPOSES_DESPITE_HINT = [
  'add_to_calendar',
  'configure_alerts',
  'create_reminder',
  'download_attachment',
  'get_email',
  'test_notification',
] as const;

const READ_ONLY_OMITS_DESPITE_HINT = ['list_labels', 'list_scheduled'] as const;

interface ListedTool {
  name: string;
  annotations?: Partial<ToolHints>;
}

interface ListedCatalog {
  tools: ListedTool[];
  prompts: { name: string }[];
  resources: { name: string }[];
  resourceTemplates: { name: string }[];
}

function registerCatalog(readOnly: boolean): ReturnType<typeof createServer> {
  const server = createServer();
  // Empty accounts keep template list() callbacks from adding concrete URIs,
  // so resources/list stays the static registrations.
  const connections = {
    getAccountNames: () => [] as string[],
    getAccount: (name: string) => ({
      name,
      email: 'owner@example.com',
      fullName: 'Owner',
    }),
  };
  const templateService = { listTemplates: async () => [] };
  const hooksService = {
    getHooksConfig: () => ({
      onNewEmail: 'notify',
      preset: 'priority-focus',
      autoLabel: false,
      autoFlag: false,
      batchDelay: 5,
      rules: [],
      alerts: {},
    }),
  };
  const config = { settings: { readOnly } } as AppConfig;
  const unused = {} as never;
  registerAllTools(
    server,
    connections as never,
    unused,
    unused,
    config,
    templateService as never,
    unused,
    unused,
    unused,
    unused,
    unused,
    hooksService as never,
  );
  registerAllResources(server, connections as never, unused, templateService as never, unused);
  registerAllPrompts(server);
  return server;
}

async function withCatalog<T>(
  readOnly: boolean,
  use: (catalog: ListedCatalog) => Promise<T>,
): Promise<T> {
  const server = registerCatalog(readOnly);
  const client = new Client({ name: 'mailoo-tool-annotations', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const listedTools = await client.listTools();
    const listedPrompts = await client.listPrompts();
    const listedResources = await client.listResources();
    const listedTemplates = await client.listResourceTemplates();
    if (
      listedTools.nextCursor ||
      listedPrompts.nextCursor ||
      listedResources.nextCursor ||
      listedTemplates.nextCursor
    ) {
      throw new Error('catalog listing paginated; the test would drop a page');
    }
    return await use({
      tools: listedTools.tools,
      prompts: listedPrompts.prompts,
      resources: listedResources.resources,
      resourceTemplates: listedTemplates.resourceTemplates,
    });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function isHintKey(key: string): key is HintKey {
  return (HINT_KEYS as readonly string[]).includes(key);
}

function booleanProblems(tools: ListedTool[]): string[] {
  const problems: string[] = [];
  for (const tool of tools) {
    const { annotations } = tool;
    if (annotations === undefined) {
      problems.push(`${tool.name}: annotations missing`);
    } else {
      for (const key of HINT_KEYS) {
        if (typeof annotations[key] !== 'boolean') {
          problems.push(`${tool.name}.${key} is ${JSON.stringify(annotations[key])}`);
        }
      }
    }
  }
  return problems;
}

function mismatchesForTool(tool: ListedTool): string[] {
  if (!Object.hasOwn(EXPECTED_TOOL_ANNOTATIONS, tool.name)) {
    return [`${tool.name}: listed but not in the annotation table`];
  }
  const expected = EXPECTED_TOOL_ANNOTATIONS[tool.name as keyof typeof EXPECTED_TOOL_ANNOTATIONS];
  const { annotations } = tool;
  if (annotations === undefined) return [`${tool.name}: annotations missing`];
  const problems: string[] = [];
  for (const key of HINT_KEYS) {
    if (annotations[key] !== expected[key]) {
      problems.push(
        `${tool.name}.${key}: ${JSON.stringify(annotations[key])} !== ${JSON.stringify(expected[key])}`,
      );
    }
  }
  for (const key of Object.keys(annotations)) {
    if (!isHintKey(key)) problems.push(`${tool.name}: unexpected annotation ${key}`);
  }
  return problems;
}

function annotationMismatches(tools: ListedTool[]): string[] {
  const listed = new Map(tools.map((tool) => [tool.name, tool]));
  const problems: string[] = [];
  for (const name of Object.keys(EXPECTED_TOOL_ANNOTATIONS)) {
    if (!listed.has(name)) problems.push(`${name}: missing from tools/list`);
  }
  for (const tool of tools) problems.push(...mismatchesForTool(tool));
  return problems;
}

describe('tool annotations', () => {
  it('should list 56 tools, 7 prompts, and 6 resources', async () => {
    await withCatalog(false, async (catalog) => {
      expect(catalog.tools).toHaveLength(56);
      expect(catalog.prompts).toHaveLength(7);
      expect(catalog.resources.length + catalog.resourceTemplates.length).toBe(6);
    });
  });

  it('should derive its tool roster from tools/list and name every tool in the annotation table', async () => {
    await withCatalog(false, async (catalog) => {
      expect(catalog.tools.map((tool) => tool.name).sort()).toEqual(
        Object.keys(EXPECTED_TOOL_ANNOTATIONS).sort(),
      );
    });
  });

  it('should declare readOnlyHint, destructiveHint, idempotentHint, and openWorldHint as booleans', async () => {
    await withCatalog(false, async (catalog) => {
      expect(booleanProblems(catalog.tools)).toEqual([]);
    });
  });

  it('should match the annotation table for every tool tools/list returns', async () => {
    await withCatalog(false, async (catalog) => {
      expect(annotationMismatches(catalog.tools)).toEqual([]);
    });
  });

  it('should expose only readOnlyHint tools when read_only is true, except tools still split by module', async () => {
    await withCatalog(true, async (catalog) => {
      const readable = new Set(
        Object.entries(EXPECTED_TOOL_ANNOTATIONS)
          .filter(([, toolHints]) => toolHints.readOnlyHint)
          .map(([name]) => name),
      );
      const exposed = catalog.tools.map((tool) => tool.name);
      const extra = exposed.filter((name) => !readable.has(name)).sort();
      const hidden = [...readable].filter((name) => !exposed.includes(name)).sort();
      expect({ extra, hidden }).toEqual({
        extra: [...READ_ONLY_EXPOSES_DESPITE_HINT],
        hidden: [...READ_ONLY_OMITS_DESPITE_HINT],
      });
    });
  });
});
