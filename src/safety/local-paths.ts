/**
 * Local filesystem paths Mailoo may read or write.
 *
 * Outgoing attachments and savePath share these checks so a broad working
 * directory or an application-data tree is not allowed on one side only.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** A cwd directly under / (or its realpath, e.g. /private/tmp on macOS) would admit other users' files. */
const BROAD_ROOT_NAMES = new Set([
  'Users',
  'home',
  'private',
  'var',
  'tmp',
  'opt',
  'usr',
  'etc',
  'proc',
  'sys',
  'dev',
  'boot',
  'root',
]);

const SYSTEM_PREFIXES = ['/etc', '/private/etc', '/proc', '/sys', '/dev', '/boot'];

const APP_DATA_TREES = new Set(['Library', 'AppData', 'snap']);

/**
 * Deliberate cap on a sanitised attachment name, not the filesystem limit.
 * NAME_MAX is 255 bytes. UTF-8 uses more than one byte per character, so a
 * byte limit would measure bytes. This value is a chosen length passed to
 * String.slice.
 */
export const SANITIZED_ATTACHMENT_NAME_MAX_CHARS = 200;

const FILENAME_UNSAFE = new Set(['/', '\\', '?', '%', '*', ':', '|', '"', '<', '>']);

export async function realpathPreservingCase(filePath: string): Promise<string> {
  // fs/promises realpath and fs.realpathSync.native restore on-disk letter case; callback fs.realpath and fs.realpathSync do not - keep this call on fs/promises; the refused-tree check depends on it
  return fs.realpath(filePath);
}

export function hiddenSegment(filePath: string): boolean {
  return filePath
    .split(/[/\\]/)
    .some((part) => part.startsWith('.') && part !== '.' && part !== '..');
}

function isSystemPath(filePath: string): boolean {
  const normalized = path.posix.normalize(filePath.replaceAll('\\', '/'));
  return SYSTEM_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

function isAppDataTree(filePath: string, homeDir: string): boolean {
  const relative = path.relative(path.resolve(homeDir), path.resolve(filePath));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const [top, second] = relative.split(path.sep);
  if (!top || !APP_DATA_TREES.has(top)) return false;
  if (top === 'Library') {
    // "Mobile Documents" also holds app iCloud containers (iCloud~...), accepted on purpose as a user-document space.
    if (second === 'Mobile Documents' || second === 'CloudStorage') return false;
  }
  return true;
}

/** Hidden segments, system locations, and application-data trees. */
export function isDisallowedLocalPath(filePath: string, homeDir: string): boolean {
  return hiddenSegment(filePath) || isSystemPath(filePath) || isAppDataTree(filePath, homeDir);
}

export async function broadRootPaths(): Promise<Set<string>> {
  const filesystemRoot = path.parse(path.resolve('/')).root;
  const children = [...BROAD_ROOT_NAMES].map((name) => path.resolve(filesystemRoot, name));
  const paths = new Set<string>(children);
  await Promise.all(
    children.map(async (candidate) => {
      try {
        paths.add(await realpathPreservingCase(candidate));
      } catch {
        // realpath fails when the directory is absent; the unresolved name is already in the set.
      }
    }),
  );
  return paths;
}

export async function specificRoot(
  root: string,
  broad: ReadonlySet<string>,
): Promise<string | undefined> {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root || broad.has(resolved)) return undefined;
  try {
    const real = await realpathPreservingCase(resolved);
    // The input form can be a symlink whose parent is not "/", or an already-resolved alias.
    if (broad.has(real)) return undefined;
    return real;
  } catch {
    return resolved;
  }
}

export async function specificRoots(cwd: string, home: string): Promise<string[]> {
  const broad = await broadRootPaths();
  const candidates = [...new Set([path.resolve(cwd), path.resolve(home)])];
  const resolved = await Promise.all(candidates.map(async (c) => specificRoot(c, broad)));
  return resolved.filter((root): root is string => root !== undefined);
}

/**
 * True when `candidate` does not escape `root`.
 * A name such as `..notes.txt` is one segment and stays inside `root`.
 */
export function isInsideRoot(
  candidate: string,
  root: string,
  options?: { allowRoot?: boolean },
): boolean {
  const allowRoot = options?.allowRoot ?? true;
  const relative = path.relative(root, candidate);
  if (relative === '') return allowRoot;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isInsideAny(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isInsideRoot(candidate, root, { allowRoot: false }));
}

export function assertAllowedLocalPath(
  filePath: string,
  roots: readonly string[],
  homeDir: string,
): void {
  if (isDisallowedLocalPath(filePath, homeDir) || !isInsideAny(filePath, roots)) {
    throw new Error('Attachment path is not allowed');
  }
}

function isUnsafeFilenameChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f || FILENAME_UNSAFE.has(char);
}

/** One path segment. `..`, separators, and control characters cannot escape the directory. */
export function sanitizeAttachmentFilename(filename: string): string {
  const base = path.posix.basename(filename.replaceAll('\\', '/').replaceAll('\0', ''));
  const cleaned = Array.from(base)
    .map((char) => (isUnsafeFilenameChar(char) ? '_' : char))
    .join('')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned.slice(0, SANITIZED_ATTACHMENT_NAME_MAX_CHARS);
}
