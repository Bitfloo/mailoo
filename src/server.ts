/**
 * MCP Server factory.
 *
 * Creates and configures the McpServer instance with capabilities and
 * MCP 2025/2026 structured output (`outputSchema` + `structuredContent`) defaults.
 */

import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { standardToolOutputSchema } from './tools/schema-helpers.js';

const esmRequire = createRequire(import.meta.url);
const pkg = esmRequire('../package.json') as { name: string; version: string };

export const PKG_NAME = pkg.name.split('/').pop() ?? 'mailoo';
export const PKG_VERSION = pkg.version;

const toolNamesByServer = new WeakMap<McpServer, Set<string>>();

/** Tools registered so far on a server from createServer; the SDK keeps its own list private. */
export function registeredToolNames(server: McpServer): ReadonlySet<string> {
  return toolNamesByServer.get(server) ?? new Set();
}

export default function createServer(): McpServer {
  const server = new McpServer(
    {
      name: PKG_NAME,
      version: PKG_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true },
        logging: {},
      },
    },
  );

  const toolNames = new Set<string>();
  toolNamesByServer.set(server, toolNames);
  const originalRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((
    name: string,
    config: Record<string, unknown>,
    cb: (...args: unknown[]) => Promise<unknown>,
  ) => {
    toolNames.add(name);
    const hasTitle = typeof config?.title === 'string';
    const effectiveConfig =
      hasTitle && !config.outputSchema
        ? { ...config, outputSchema: standardToolOutputSchema }
        : config;

    const wrappedCb = async (...args: unknown[]) => {
      const res = await cb(...args);
      if (
        res &&
        typeof res === 'object' &&
        'content' in res &&
        !(res as { structuredContent?: unknown }).structuredContent &&
        effectiveConfig?.outputSchema
      ) {
        const contentArr = (res as { content?: { type?: string; text?: string }[] }).content;
        // Every block: download_attachment and export_email put the base64 in the second one.
        // The whole result, not a digest: Claude Code (2.1.x) hands the model this object in
        // place of the text blocks, so text left out of summary never reaches the model.
        const summary = (Array.isArray(contentArr) ? contentArr : [])
          .flatMap((c) => (c.type === 'text' && typeof c.text === 'string' ? [c.text] : []))
          .join('\n');
        const isDryRun = summary.startsWith('[DRY RUN]');
        return {
          ...(res as Record<string, unknown>),
          structuredContent: {
            ok: (res as { isError?: boolean }).isError !== true,
            summary,
            ...(isDryRun ? { dryRun: true } : {}),
          },
        };
      }
      return res;
    };

    return originalRegisterTool(name, effectiveConfig as never, wrappedCb as never);
  }) as typeof server.registerTool;

  return server;
}
