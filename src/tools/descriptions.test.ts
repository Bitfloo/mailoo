/**
 * Tool and parameter descriptions are the contract a client reads before it
 * calls a tool. A snake_case token that is not a tool, a parameter, an enum
 * value, or an add-to-calendar status sends the client after something this
 * server does not expose.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { ADD_EVENT_STATUSES } from '../services/local-calendar.service.js';
import buildCatalog from '../test-support/mcp-catalog-harness.js';
import { registerCalendarAllTools } from './calendar.tool.js';

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

async function listedTools(): Promise<ListedTool[]> {
  const server = buildCatalog({ readOnly: false, accounts: [] });
  const client = new Client({ name: 'mailoo-tool-descriptions', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const listed = await client.listTools();
    if (listed.nextCursor) throw new Error('tools/list paginated; the test would drop a page');
    return listed.tools;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function walkSchema(schema: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (schema === null || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;
  visit(node);
  const { properties, items, anyOf, oneOf, allOf } = node;
  if (properties !== null && typeof properties === 'object') {
    for (const child of Object.values(properties as Record<string, unknown>)) {
      walkSchema(child, visit);
    }
  }
  walkSchema(items, visit);
  for (const branch of [anyOf, oneOf, allOf]) {
    if (Array.isArray(branch)) {
      for (const child of branch) {
        walkSchema(child, visit);
      }
    }
  }
}

function parameterNames(schema: unknown): Set<string> {
  const names = new Set<string>();
  walkSchema(schema, (node) => {
    const { properties } = node;
    if (properties === null || typeof properties !== 'object') return;
    for (const key of Object.keys(properties as Record<string, unknown>)) names.add(key);
  });
  return names;
}

function enumValues(schema: unknown): Set<string> {
  const values = new Set<string>();
  walkSchema(schema, (node) => {
    const { enum: options } = node;
    if (!Array.isArray(options)) return;
    for (const option of options) {
      if (typeof option === 'string') values.add(option);
    }
  });
  return values;
}

function descriptionTexts(tool: ListedTool): string[] {
  const texts: string[] = [];
  if (typeof tool.description === 'string') texts.push(tool.description);
  walkSchema(tool.inputSchema, (node) => {
    if (typeof node.description === 'string') texts.push(node.description);
  });
  return texts;
}

/** An underscore is required so ordinary words are not treated as identifiers. */
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

describe('tool descriptions', () => {
  it('should only mention a tool, parameter, enum value, or calendar status', async () => {
    const tools = await listedTools();
    const toolNames = new Set(tools.map((tool) => tool.name));
    const parameters = new Set<string>();
    const enums = new Set<string>();
    for (const tool of tools) {
      for (const name of parameterNames(tool.inputSchema)) parameters.add(name);
      for (const value of enumValues(tool.inputSchema)) enums.add(value);
    }
    const statuses = new Set<string>(ADD_EVENT_STATUSES);
    const problems: string[] = [];
    for (const tool of tools) {
      for (const text of descriptionTexts(tool)) {
        for (const token of text.match(SNAKE_CASE) ?? []) {
          const known =
            toolNames.has(token) ||
            parameters.has(token) ||
            enums.has(token) ||
            statuses.has(token);
          if (!known) problems.push(`${tool.name}: ${token}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('should say forward_email does not include the original attachments', async () => {
    const tools = await listedTools();
    const forward = tools.find((tool) => tool.name === 'forward_email');
    expect(forward?.description).toContain('Original attachments are not included.');
  });

  it('should say bulk_action delete moves the messages to Trash', async () => {
    const tools = await listedTools();
    const bulk = tools.find((tool) => tool.name === 'bulk_action');
    expect(bulk?.description).toContain('delete moves the messages to Trash');
  });

  it('should say cancel_scheduled moves the associated draft to Trash', async () => {
    const tools = await listedTools();
    const cancel = tools.find((tool) => tool.name === 'cancel_scheduled');
    expect(cancel?.description).toContain('moves the associated draft to Trash');
  });
});

describe('add_to_calendar duplicate hint', () => {
  it('should not tell the client to pass skipDuplicateCheck when the event already exists', async () => {
    let handler:
      | ((args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>)
      | undefined;
    const server = {
      registerTool: (name: string, _config: unknown, fn: typeof handler) => {
        if (name === 'add_to_calendar') handler = fn;
      },
    };
    registerCalendarAllTools(
      server as never,
      {
        getEmail: async () => ({
          subject: 'Standup',
          from: { name: 'Ada', address: 'ada@example.com' },
          date: '2026-02-01T10:00:00.000Z',
          bodyText: 'See you then',
          bodyHtml: '',
          attachments: [],
        }),
        getCalendarParts: async () => [],
      } as never,
      {} as never,
      {
        addEvent: async () => ({
          status: 'duplicate',
          message: 'exists',
          duplicate: { eventId: 'e1', calendarName: 'Home' },
        }),
      } as never,
      {} as never,
    );
    if (!handler) throw new Error('add_to_calendar was not registered');
    const result = await handler({
      account: 'personal',
      email_id: '1',
      mailbox: 'INBOX',
      save_attachments: false,
    });
    expect(result.content[0]?.text).not.toContain('skipDuplicateCheck');
  });
});
