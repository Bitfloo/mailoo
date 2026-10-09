/**
 * Shared stubs for export_email unit suites. Kept out of the suites so each
 * file stays under the 300 code-LOC unit size gate.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { z } from 'zod';

import type { IConnectionManager } from '../connections/types.js';
import ImapService from '../services/imap.service.js';
import registerExportTools from '../tools/export.tool.js';

export interface ExportArgs {
  account: string;
  id: string;
  mailbox: string;
  savePath?: string;
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

export interface ToolConfig {
  inputSchema: z.ZodRawShape;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** What imapflow's fetchOne returns for one UID. */
export interface ServerMessage {
  size?: number;
  internalDate?: Date | string;
  /** Absent when the test claims the source is never transferred. */
  source?: Buffer;
}

export const ACCOUNT = 'personal';
export const UID = '42';
const MARKER = '--- Base64 Content ---\n';

/** A Latin-1 body sent as 8bit: 0xE9 and 0xFF are not valid UTF-8 on their own. */
export const EIGHT_BIT_SOURCE = Buffer.concat([
  Buffer.from(
    'From: shop@example.com\r\nTo: me@example.test\r\nSubject: Receipt\r\n' +
      'Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCaf',
  ),
  Buffer.from([0xe9, 0x20, 0xff, 0x0d, 0x0a]),
]);

export function serviceFor(message: ServerMessage): ImapService {
  const client = {
    getMailboxLock: async () => ({ release: () => undefined }),
    fetchOne: async (uid: string, query: { source?: unknown }) => {
      if (query.source) {
        if (!message.source) throw new Error('the source was fetched for a message over the cap');
        return { uid: Number(uid), source: message.source };
      }
      return { uid: Number(uid), size: message.size, internalDate: message.internalDate };
    },
  };
  return new ImapService({ getImapClient: async () => client } as unknown as IConnectionManager);
}

export function register(
  imap: ImapService,
  readOnly: boolean,
): { config: ToolConfig; run: (args: ExportArgs) => Promise<ToolResult> } {
  let config: ToolConfig | undefined;
  let handler: ((args: ExportArgs) => Promise<ToolResult>) | undefined;
  const server = {
    registerTool: (
      _name: string,
      cfg: ToolConfig,
      fn: (args: ExportArgs) => Promise<ToolResult>,
    ) => {
      config = cfg;
      handler = fn;
    },
  };
  registerExportTools(server as never, imap, readOnly);
  if (!config || !handler) throw new Error('export tool was not registered');
  return { config, run: handler };
}

export function exportTool(
  message: ServerMessage,
  readOnly = false,
): (args: ExportArgs) => Promise<ToolResult> {
  return register(serviceFor(message), readOnly).run;
}

export function inlineBytes(result: ToolResult): Buffer {
  const part = result.content.find((entry) => entry.text.includes(MARKER));
  if (!part) throw new Error(`no base64 part in ${JSON.stringify(result.content)}`);
  return Buffer.from(part.text.slice(part.text.indexOf(MARKER) + MARKER.length).trim(), 'base64');
}

export function reason(result: ToolResult): string {
  const text = result.content[0]?.text ?? '';
  return text.slice(text.indexOf(': ') + 2);
}

export async function withPinnedRoots<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-export-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-export-home-'));
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    return await fn(cwd);
  } finally {
    cwdSpy.mockRestore();
    homeSpy.mockRestore();
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
}

export async function withTimeZone<T>(zone: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}
