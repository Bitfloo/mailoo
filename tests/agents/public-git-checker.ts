import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoRoot } from './agent-file.js';

export const checkerScript = join(repoRoot, 'scripts/check-public-git-log.sh');
export const publicGitRule = join(repoRoot, '.claude/rules/public-git.md');

export const clean = 'docs: name the integration IMAP server\n';
export const leak = 'fix: path /Users/me/mailoo\n';
export const passed = { status: 0, stdout: '', stderr: '' };

export type Result = { status: number; stdout: string; stderr: string };

const tmpDirs: string[] = [];

export function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

export function removeTmpDirs(): void {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function denylist(content: string): string {
  const file = join(makeTmpDir('mailoo-public-git-list-'), 'public-git-denylist');
  writeFileSync(file, content);
  return file;
}

/** A PATH whose `cat` always fails: root reads any file mode, so this stands in for an unreadable file. */
export function pathWithFailingCat(): string {
  const bin = join(makeTmpDir('mailoo-public-git-cat-'), 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'cat'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(bin, 'cat'), 0o755);
  return `${bin}:${process.env.PATH ?? ''}`;
}

/**
 * A git hook or linked worktree exports GIT_DIR and friends, which would aim the checker's git
 * at the outer repository, and a maintainer's own PUBLIC_GIT_* patterns would change what it rejects.
 */
export function cleanEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(base)) {
    if (key.startsWith('GIT_') || key.startsWith('PUBLIC_GIT_')) {
      delete base[key];
    }
  }
  base.GIT_CONFIG_GLOBAL = '/dev/null';
  base.GIT_CONFIG_NOSYSTEM = '1';
  return { ...base, ...env };
}

export function runChecker(args: string[], cwd: string, env: Record<string, string>): Result {
  const result = spawnSync('bash', [checkerScript, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(env),
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** Checks `body` as a message file, with no default denylist unless `env` names one. */
export function scanFile(body: string, env: Record<string, string> = {}): Result {
  const dir = makeTmpDir('mailoo-public-git-');
  const file = join(dir, 'COMMIT_EDITMSG');
  writeFileSync(file, body);
  return runChecker(['--file', file], dir, {
    PUBLIC_GIT_DENYLIST_FILE: join(dir, 'no-denylist'),
    ...env,
  });
}

export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: cleanEnv({}) },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export function initRepo(): string {
  const dir = makeTmpDir('mailoo-public-git-repo-');
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'chore: initial commit');
  return dir;
}
