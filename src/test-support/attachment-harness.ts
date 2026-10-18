/** Pinned working and home directories and a captured download_attachment handler. */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type ImapService from '../services/imap.service.js';
import registerAttachmentTools from '../tools/attachments.tool.js';

export type DownloadHandler = (args: {
  account: string;
  id: string;
  mailbox: string;
  filename: string;
  savePath?: string;
}) => Promise<{ isError?: boolean; content: { type: string; text: string }[] }>;

export function captureDownload(imap: unknown, readOnly: boolean): DownloadHandler {
  let handler: DownloadHandler | undefined;
  const server = {
    registerTool: (...args: unknown[]) => {
      handler = args[2] as DownloadHandler;
    },
  };
  registerAttachmentTools(server as never, imap as ImapService, readOnly);
  if (!handler) throw new Error('download_attachment handler was not registered');
  return handler;
}

export async function withPinnedRoots<T>(
  cwd: string,
  home: string,
  fn: () => Promise<T>,
): Promise<T> {
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
  try {
    return await fn();
  } finally {
    cwdSpy.mockRestore();
    homeSpy.mockRestore();
  }
}

export async function withCwdTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-att-'));
  try {
    return await withPinnedRoots(dir, dir, async () => fn(dir));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function withTempCwdAndHome<T>(
  fn: (dirs: { cwd: string; home: string }) => Promise<T>,
): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-cwd-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-home-'));
  try {
    return await withPinnedRoots(cwd, home, async () => fn({ cwd, home }));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
}
