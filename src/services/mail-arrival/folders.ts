import { mcpLog } from '../../logging.js';
import type { AccountConfig, SystemOneFolderSpec } from '../../types/index.js';
import type ImapService from '../imap.service.js';
import type { FolderSpec } from './policy.js';
import { slugFolderId } from './questions.js';

export async function buildFolderSpecs(
  folders: readonly SystemOneFolderSpec[],
): Promise<FolderSpec[] | null> {
  const slugToPath = new Map<string, string>();
  const folderSpecs: FolderSpec[] = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const folder of folders) {
    const id = slugFolderId(folder.path);
    if (!id) {
      // eslint-disable-next-line no-await-in-loop
      await mcpLog(
        'error',
        'mail-arrival',
        `system_one: could not slug folder path "${folder.path}"`,
      );
      return null;
    }
    const previous = slugToPath.get(id);
    if (previous !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      await mcpLog(
        'error',
        'mail-arrival',
        `system_one: folder slug collision "${id}" for "${previous}" and "${folder.path}"`,
      );
      return null;
    }
    slugToPath.set(id, folder.path);
    folderSpecs.push({
      id,
      path: folder.path,
      description: folder.description,
      falseCriteria: folder.falseCriteria,
      priority: folder.priority,
    });
  }
  return folderSpecs;
}

export async function probeAccountFolders(
  imap: ImapService,
  accounts: readonly AccountConfig[],
  folderSpecs: readonly FolderSpec[],
  extraPaths: readonly string[],
): Promise<Map<string, FolderSpec[]>> {
  const foldersByAccount = new Map<string, FolderSpec[]>();
  // eslint-disable-next-line no-restricted-syntax
  for (const account of accounts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const boxes = await imap.listMailboxes(account.name);
      const paths = new Set(boxes.map((b) => b.path));

      extraPaths.forEach((path) => {
        if (!paths.has(path)) {
          mcpLog(
            'warning',
            'mail-arrival',
            `system_one: unknown move_to path "${path}" on ${account.name}`,
          ).catch(() => {});
        }
      });

      const visible = folderSpecs.filter((folder) => {
        if (paths.has(folder.path)) return true;
        mcpLog(
          'warning',
          'mail-arrival',
          `system_one: unknown folder path "${folder.path}" on ${account.name} — dropped`,
        ).catch(() => {});
        return false;
      });
      if (visible.length === 0 && folderSpecs.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        await mcpLog(
          'warning',
          'mail-arrival',
          `system_one: no configured folders exist on ${account.name} — classify/flag only; no MOVE`,
        );
      }
      foldersByAccount.set(account.name, visible);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-await-in-loop
      await mcpLog(
        'warning',
        'mail-arrival',
        `system_one: LIST failed for ${account.name}: ${msg} — dropping folders on this account`,
      );
      foldersByAccount.set(account.name, []);
    }
  }
  return foldersByAccount;
}
