/**
 * MCP client config files: where each supported client keeps its JSON, and
 * reading and writing it without losing the user's other servers.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { writeConfigFile } from '../config/loader.js';
import isEnoent from '../utils/fs-errors.js';

export const MCP_SERVER_KEY = 'mailoo';

// ---------------------------------------------------------------------------
// MCP client registry
// ---------------------------------------------------------------------------

export interface McpClientDef {
  /** Human-readable name shown in prompts */
  name: string;
  /** Short id used internally */
  id: string;
  /** Absolute path to the JSON config file for this client */
  configPath: string;
  /** JSON key under which MCP servers live */
  serversKey: string;
}

export function getClients(): McpClientDef[] {
  const platform = os.platform();
  const home = os.homedir();

  const clients: McpClientDef[] = [];

  if (platform === 'darwin') {
    clients.push({
      name: 'Claude Desktop',
      id: 'claude',
      configPath: path.join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      ),
      serversKey: 'mcpServers',
    });
  } else if (platform === 'linux') {
    clients.push({
      name: 'Claude Desktop',
      id: 'claude',
      configPath: path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'),
        'Claude',
        'claude_desktop_config.json',
      ),
      serversKey: 'mcpServers',
    });
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    clients.push({
      name: 'Claude Desktop',
      id: 'claude',
      configPath: path.join(appData, 'Claude', 'claude_desktop_config.json'),
      serversKey: 'mcpServers',
    });
  }

  // Cursor — ~/.cursor/mcp.json (all platforms)
  clients.push({
    name: 'Cursor',
    id: 'cursor',
    configPath: path.join(home, '.cursor', 'mcp.json'),
    serversKey: 'mcpServers',
  });

  // Windsurf / Codeium — ~/.codeium/windsurf/mcp_config.json
  clients.push({
    name: 'Windsurf',
    id: 'windsurf',
    configPath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    serversKey: 'mcpServers',
  });

  return clients;
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class ClientConfigParseError extends Error {}

/**
 * A missing or empty file has nothing to keep and reads as {}. Anything else
 * that is not a JSON object throws: writing {} plus the mailoo entry back would
 * replace the user's other servers.
 */
export async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    // The parser's message quotes the file, which may hold other servers' keys.
    throw new ClientConfigParseError(
      `${filePath} is not valid JSON (an object is expected). It was not changed; fix it and run the command again.`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** Temp file plus rename (mode 0600), so an interrupted write cannot truncate the client config. */
export async function writeJsonFile(
  filePath: string,
  data: Record<string, unknown>,
): Promise<void> {
  await writeConfigFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function isRegistered(config: Record<string, unknown>, serversKey: string): boolean {
  const servers = config[serversKey] as Record<string, unknown> | undefined;
  return servers != null && MCP_SERVER_KEY in servers;
}
