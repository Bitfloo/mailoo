/**
 * Catalog tests share one registration stub. A new service argument is wired
 * here, so each suite does not grow its own copy.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import registerAllPrompts from '../prompts/register.js';
import registerAllResources from '../resources/register.js';
import createServer, { registeredToolNames } from '../server.js';
import registerAllTools from '../tools/register.js';
import type { AppConfig, ToolsetProfile } from '../types/index.js';

export default function buildCatalog({
  readOnly,
  accounts,
  toolset,
}: {
  readOnly: boolean;
  accounts: readonly string[];
  toolset?: ToolsetProfile;
}): McpServer {
  const server = createServer();
  const connections = {
    getAccountNames: () => [...accounts],
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
  const config = { settings: { readOnly, toolset } } as AppConfig;
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
  registerAllPrompts(server, registeredToolNames(server));
  return server;
}
