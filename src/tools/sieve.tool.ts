/**
 * MCP tools for ManageSieve (RFC 5804) filter scripts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type ConnectionManager from '../connections/manager.js';
import audit from '../safety/audit.js';
import type { SieveService } from '../services/sieve.service.js';

export function registerSieveReadTools(
  server: McpServer,
  connections: ConnectionManager,
  sieveService: SieveService,
): void {
  server.tool(
    'sieve_status',
    'Detect whether ManageSieve is available for an account (port 4190 by default). ' +
      'If the provider only exposes filters in a web UI, this reports a warning rather than IMAP capabilities.',
    {
      account: z.string().describe('Account name from list_accounts'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account }) => {
      try {
        const cfg = connections.getAccount(account);
        const status = await sieveService.status(cfg);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `SIEVE status failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    'sieve_list_scripts',
    'List ManageSieve scripts on the account (RFC 5804 LISTSCRIPTS).',
    {
      account: z.string().describe('Account name from list_accounts'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account }) => {
      try {
        const scripts = await sieveService.listScripts(connections.getAccount(account));
        if (scripts.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No SIEVE scripts on this account.' }],
          };
        }
        const lines = scripts.map((s) => `${s.active ? '●' : '○'} ${s.name}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `LISTSCRIPTS failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    'sieve_get_script',
    'Download a ManageSieve script by name (RFC 5804 GETSCRIPT).',
    {
      account: z.string().describe('Account name from list_accounts'),
      name: z.string().describe('Script name from sieve_list_scripts'),
    },
    { readOnlyHint: true, destructiveHint: false },
    async ({ account, name }) => {
      try {
        const body = await sieveService.getScript(connections.getAccount(account), name);
        return { content: [{ type: 'text' as const, text: body || '(empty script)' }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `GETSCRIPT failed: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}

export function registerSieveWriteTools(
  server: McpServer,
  connections: ConnectionManager,
  sieveService: SieveService,
): void {
  server.tool(
    'sieve_put_script',
    'Create or replace a ManageSieve script (RFC 5804 PUTSCRIPT). Does not activate it.',
    {
      account: z.string().describe('Account name from list_accounts'),
      name: z.string().describe('Script name'),
      content: z.string().describe('SIEVE script source (RFC 5228)'),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ account, name, content }) => {
      try {
        await sieveService.putScript(connections.getAccount(account), name, content);
        await audit.log('sieve_put_script', account, { name }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Saved SIEVE script "${name}". Use sieve_activate_script to enable it.`,
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('sieve_put_script', account, { name }, 'error', errMsg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `PUTSCRIPT failed: ${errMsg}` }],
        };
      }
    },
  );

  server.tool(
    'sieve_delete_script',
    'Delete a ManageSieve script (RFC 5804 DELETESCRIPT). Active scripts must be deactivated first.',
    {
      account: z.string().describe('Account name from list_accounts'),
      name: z.string().describe('Script name'),
    },
    { readOnlyHint: false, destructiveHint: true },
    async ({ account, name }) => {
      try {
        await sieveService.deleteScript(connections.getAccount(account), name);
        await audit.log('sieve_delete_script', account, { name }, 'ok');
        return { content: [{ type: 'text' as const, text: `Deleted SIEVE script "${name}".` }] };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('sieve_delete_script', account, { name }, 'error', errMsg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `DELETESCRIPT failed: ${errMsg}` }],
        };
      }
    },
  );

  server.tool(
    'sieve_activate_script',
    'Activate a ManageSieve script (RFC 5804 SETACTIVE). Pass an empty name to deactivate all.',
    {
      account: z.string().describe('Account name from list_accounts'),
      name: z.string().describe('Script name, or empty string to deactivate'),
    },
    { readOnlyHint: false, destructiveHint: false },
    async ({ account, name }) => {
      try {
        await sieveService.activateScript(connections.getAccount(account), name);
        await audit.log('sieve_activate_script', account, { name }, 'ok');
        return {
          content: [
            {
              type: 'text' as const,
              text: name ? `Activated SIEVE script "${name}".` : 'Deactivated all SIEVE scripts.',
            },
          ],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('sieve_activate_script', account, { name }, 'error', errMsg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `SETACTIVE failed: ${errMsg}` }],
        };
      }
    },
  );
}
