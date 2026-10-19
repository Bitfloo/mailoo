/**
 * Prompt registration — single wiring point.
 *
 * Registers the MCP prompts the registered tools can carry out. A prompt that
 * names a tool the toolset profile or read_only left out sends the model after
 * a tool it cannot call, so it is left out or drops that step.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import registerActionsPrompt from './actions.prompt.js';
import registerCalendarPrompt from './calendar.prompt.js';
import registerCleanupPrompt from './cleanup.prompt.js';
import registerComposePrompts from './compose.prompt.js';
import registerThreadPrompt from './thread.prompt.js';
import registerTriagePrompt from './triage.prompt.js';

export default function registerAllPrompts(server: McpServer, tools: ReadonlySet<string>): void {
  registerTriagePrompt(server);
  if (tools.has('get_thread')) registerThreadPrompt(server);
  registerComposePrompts(server, tools);
  registerActionsPrompt(server);
  if (tools.has('extract_calendar')) registerCalendarPrompt(server);
  registerCleanupPrompt(server, tools);
}
