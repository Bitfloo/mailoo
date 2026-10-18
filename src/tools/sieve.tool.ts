/**
 * MCP tools for ManageSieve (RFC 5804) filter scripts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type ConnectionManager from '../connections/manager.js';
import audit from '../safety/audit.js';
import type { SieveService } from '../services/sieve.service.js';
import { accountParam, dryRunParam, structuredToolResult } from './schema-helpers.js';

export function registerSieveReadTools(
  server: McpServer,
  connections: ConnectionManager,
  sieveService: SieveService,
): void {
  server.registerTool(
    'sieve_status',
    {
      title: 'Check Sieve Availability',
      description:
        'Detect whether ManageSieve is available for an account (port 4190 by default). ' +
        'If the provider only exposes filters in a web UI, this reports a warning rather than IMAP capabilities.',
      inputSchema: {
        account: accountParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account }) => {
      try {
        const cfg = connections.getAccount(account ?? '');
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

  server.registerTool(
    'sieve_list_scripts',
    {
      title: 'List Sieve Scripts',
      description: 'List ManageSieve scripts on the account (RFC 5804 LISTSCRIPTS).',
      inputSchema: {
        account: accountParam,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account }) => {
      try {
        const scripts = await sieveService.listScripts(connections.getAccount(account ?? ''));
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

  server.registerTool(
    'sieve_get_script',
    {
      title: 'Get Sieve Script',
      description: 'Download a ManageSieve script by name (RFC 5804 GETSCRIPT).',
      inputSchema: {
        account: accountParam,
        name: z.string().describe('Script name from sieve_list_scripts'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, name }) => {
      try {
        const body = await sieveService.getScript(connections.getAccount(account ?? ''), name);
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
  server.registerTool(
    'sieve_put_script',
    {
      title: 'Save Sieve Script',
      description:
        'Create or replace a ManageSieve script (RFC 5804 PUTSCRIPT). Does not activate it.',
      inputSchema: {
        account: accountParam,
        name: z.string().describe('Script name'),
        content: z.string().describe('SIEVE script source (RFC 5228)'),
        dryRun: dryRunParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, name, content, dryRun }) => {
      const accountInput = account ?? '';
      try {
        const cfg = connections.getAccount(accountInput);
        if (dryRun) {
          return structuredToolResult(
            `[DRY RUN] Would save SIEVE script "${name}" (${content.length} chars) on account "${cfg.name}".`,
            {
              action: 'sieve_put_script',
              account: cfg.name,
              name,
              contentLength: content.length,
            },
            true,
          );
        }
        await sieveService.putScript(cfg, name, content);
        await audit.log('sieve_put_script', cfg.name, { name }, 'ok');
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
        await audit.log('sieve_put_script', accountInput, { name }, 'error', errMsg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `PUTSCRIPT failed: ${errMsg}` }],
        };
      }
    },
  );

  server.registerTool(
    'sieve_delete_script',
    {
      title: 'Delete Sieve Script',
      description:
        'Delete a ManageSieve script (RFC 5804 DELETESCRIPT). Active scripts must be deactivated first.',
      inputSchema: {
        account: accountParam,
        name: z.string().describe('Script name'),
        dryRun: dryRunParam,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, name, dryRun }) => {
      const accountInput = account ?? '';
      try {
        const cfg = connections.getAccount(accountInput);
        if (dryRun) {
          return structuredToolResult(
            `[DRY RUN] Would delete SIEVE script "${name}" on account "${cfg.name}".`,
            {
              action: 'sieve_delete_script',
              account: cfg.name,
              name,
            },
            true,
          );
        }
        await sieveService.deleteScript(cfg, name);
        await audit.log('sieve_delete_script', cfg.name, { name }, 'ok');
        return { content: [{ type: 'text' as const, text: `Deleted SIEVE script "${name}".` }] };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log('sieve_delete_script', accountInput, { name }, 'error', errMsg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `DELETESCRIPT failed: ${errMsg}` }],
        };
      }
    },
  );

  server.registerTool(
    'sieve_activate_script',
    {
      title: 'Activate Sieve Script',
      description:
        'Activate a ManageSieve script (RFC 5804 SETACTIVE). Pass an empty name to deactivate all.',
      inputSchema: {
        account: accountParam,
        name: z.string().describe('Script name, or empty string to deactivate'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, name }) => {
      const accountInput = account ?? '';
      try {
        const cfg = connections.getAccount(accountInput);
        await sieveService.activateScript(cfg, name);
        await audit.log('sieve_activate_script', cfg.name, { name }, 'ok');
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
        await audit.log('sieve_activate_script', accountInput, { name }, 'error', errMsg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `SETACTIVE failed: ${errMsg}` }],
        };
      }
    },
  );
}
