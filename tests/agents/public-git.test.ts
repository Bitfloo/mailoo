import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { repoRoot } from './agent-file.js';

const script = join(repoRoot, 'scripts/check-public-git-log.sh');
const publicGit = join(repoRoot, '.claude/rules/public-git.md');

const tmpDirs: string[] = [];

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type Result = { status: number; stderr: string };

/** Process env without git or checker variables, so the caller's repository cannot leak in. */
function cleanEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const key of Object.keys(base)) {
    if (key.startsWith('GIT_') && !key.startsWith('GIT_CONFIG')) {
      delete base[key];
    }
  }
  delete base.PUBLIC_GIT_EXTRA_FORBIDDEN;
  delete base.PUBLIC_GIT_DENYLIST_FILE;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete base[key];
    } else {
      base[key] = value;
    }
  }
  return base;
}

function runChecker(args: string[], cwd: string, env: Record<string, string | undefined>): Result {
  const result = spawnSync('bash', [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(env),
  });
  return { status: result.status ?? 1, stderr: result.stderr };
}

function scanFile(body: string, env: Record<string, string | undefined> = {}): Result {
  const dir = makeTmpDir('mailoo-public-git-');
  const file = join(dir, 'COMMIT_EDITMSG');
  writeFileSync(file, body);
  return runChecker(['--file', file], dir, {
    PUBLIC_GIT_DENYLIST_FILE: join(dir, 'no-denylist'),
    ...env,
  });
}

function git(cwd: string, ...args: string[]): string {
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

function initRepo(): string {
  const dir = makeTmpDir('mailoo-public-git-repo-');
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'chore: initial commit');
  return dir;
}

const clean = 'docs: name the integration IMAP server\n';
const leak = 'fix: path /Users/me/mailoo\n';

describe('public git log gate', () => {
  it('ships the rubric and a checker that git tracks as executable', () => {
    expect(existsSync(publicGit)).toBe(true);
    const mode = spawnSync('git', ['ls-files', '-s', 'scripts/check-public-git-log.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(mode.stdout).toMatch(/^100755 /);
  });

  it('points the rubric at the checker instead of keeping a second copy of its pattern', () => {
    const builtin = readFileSync(script, 'utf8').match(/^BUILTIN='([^']+)'/m)?.[1];
    expect(builtin).toBeTruthy();
    const rule = readFileSync(publicGit, 'utf8');
    expect(rule).toContain('scripts/check-public-git-log.sh');
    expect(rule).not.toContain(builtin as string);
  });

  it('accepts a conventional subject with no operator leak', () => {
    expect(scanFile(clean)).toEqual({ status: 0, stderr: '' });
  });

  it('accepts a project agent name without a plugin prefix', () => {
    expect(scanFile('docs: run the project test-auditor and push-gate agents\n').status).toBe(0);
  });

  it.each([
    ['a macOS home path', 'fix: path /Users/me/mailoo\n'],
    ['a Linux home path', 'fix: path /home/me/mailoo\n'],
    ['a session trailer', 'docs: note a change\n\nClaude-Session: 0123abc\n'],
    ['a session link', 'docs: see https://claude.ai/code/session_0123abc\n'],
    ['a plugin test-auditor dispatch', 'chore: do not dispatch acme:test-auditor\n'],
    ['a plugin test-smith dispatch', 'chore: do not dispatch acme:test-smith\n'],
    ['a plugin push-gate dispatch', 'chore: do not dispatch acme:push-gate\n'],
  ])('rejects %s', (_name, body) => {
    const result = scanFile(body);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('forbidden token');
  });

  it('matches built-in patterns case-insensitively', () => {
    expect(scanFile('fix: path /users/me/mailoo\n').status).toBe(1);
    expect(scanFile('docs: note\n\nclaude-session: 0123abc\n').status).toBe(1);
    expect(scanFile('chore: do not dispatch ACME:TEST-SMITH\n').status).toBe(1);
  });

  it('rejects a private pattern from the environment only when it is set', () => {
    const body = 'docs: load the example-private-tree notes\n';
    expect(scanFile(body).status).toBe(0);
    expect(scanFile(body, { PUBLIC_GIT_EXTRA_FORBIDDEN: 'example-private-tree' }).status).toBe(1);
  });

  it('matches an extra pattern from the environment case-insensitively', () => {
    const env = { PUBLIC_GIT_EXTRA_FORBIDDEN: 'example-private-tree' };
    expect(scanFile('docs: load the Example-Private-Tree notes\n', env).status).toBe(1);
  });

  it('matches a denylist pattern case-insensitively', () => {
    const list = join(makeTmpDir('mailoo-public-git-list-'), 'public-git-denylist');
    writeFileSync(list, 'example-private-tree\n');
    const env = { PUBLIC_GIT_DENYLIST_FILE: list };
    expect(scanFile('docs: load the Example-Private-Tree notes\n', env).status).toBe(1);
  });

  it('reads a denylist saved with CRLF line endings', () => {
    const list = join(makeTmpDir('mailoo-public-git-list-'), 'public-git-denylist');
    writeFileSync(list, '# private patterns\r\nexample-private-tree\r\nother-secret-name\r\n');
    const env = { PUBLIC_GIT_DENYLIST_FILE: list };
    expect(scanFile('docs: load the example-private-tree notes\n', env).status).toBe(1);
    expect(scanFile('docs: mention other-secret-name\n', env).status).toBe(1);
    expect(scanFile(clean, env)).toEqual({ status: 0, stderr: '' });
  });

  it('skips blank lines and comments between denylist patterns', () => {
    const dir = makeTmpDir('mailoo-public-git-list-');
    const list = join(dir, 'public-git-denylist');
    writeFileSync(
      list,
      'example-private-tree\n\n# comment with (regex) metachars [ * |\nother-secret-name',
    );
    const env = { PUBLIC_GIT_DENYLIST_FILE: list };
    expect(scanFile(clean, env)).toEqual({ status: 0, stderr: '' });
    expect(scanFile('docs: load the example-private-tree notes\n', env).status).toBe(1);
    expect(scanFile('docs: mention other-secret-name\n', env).status).toBe(1);
  });

  it('reads the default denylist from the repository git dir', () => {
    const repo = initRepo();
    writeFileSync(join(repo, '.git/info/public-git-denylist'), 'example-private-tree\n');
    const msg = join(repo, 'MSG');
    writeFileSync(msg, 'docs: load the example-private-tree notes\n');
    expect(runChecker(['--file', msg], repo, {}).status).toBe(1);
    writeFileSync(msg, clean);
    expect(runChecker(['--file', msg], repo, {}).status).toBe(0);
  });

  it('reads the shared denylist from a linked worktree, where .git is a file', () => {
    const repo = initRepo();
    mkdirSync(join(repo, '.git/info'), { recursive: true });
    writeFileSync(join(repo, '.git/info/public-git-denylist'), 'example-private-tree\n');
    const worktree = join(makeTmpDir('mailoo-public-git-wt-'), 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', worktree);
    const msg = join(worktree, 'MSG');
    writeFileSync(msg, 'docs: load the example-private-tree notes\n');
    expect(runChecker(['--file', msg], worktree, {}).status).toBe(1);
  });

  it('runs the built-in patterns outside a git repository', () => {
    const dir = makeTmpDir('mailoo-public-git-norepo-');
    mkdirSync(join(dir, '.git/info'), { recursive: true });
    writeFileSync(join(dir, '.git/info/public-git-denylist'), 'example-private-tree\n');
    const msg = join(dir, 'MSG');
    writeFileSync(msg, 'docs: load the example-private-tree notes\n');
    const env = { GIT_CEILING_DIRECTORIES: dirname(dir) };
    expect(runChecker(['--file', msg], dir, env)).toEqual({ status: 0, stderr: '' });
    writeFileSync(msg, leak);
    expect(runChecker(['--file', msg], dir, env).status).toBe(1);
  });

  it.each([
    [
      'the environment',
      (dir: string) => ({
        PUBLIC_GIT_EXTRA_FORBIDDEN: '(private-marker-env',
        PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
      }),
    ],
    [
      'the denylist file',
      (dir: string) => {
        const list = join(dir, 'public-git-denylist');
        writeFileSync(list, 'example-private-tree\nprivate-marker-list(\n');
        return { PUBLIC_GIT_DENYLIST_FILE: list };
      },
    ],
  ])('fails closed on a malformed extra pattern from %s', (_source, makeEnv) => {
    const env = makeEnv(makeTmpDir('mailoo-public-git-bad-'));
    const withLeak = scanFile(leak, env);
    expect(withLeak.status).toBe(2);
    expect(withLeak.stderr).toContain('invalid extra pattern');
    expect(withLeak.stderr).toContain('/Users/me/mailoo');
    expect(withLeak.stderr).not.toContain('private-marker');
    const withoutLeak = scanFile(clean, env);
    expect(withoutLeak.status).toBe(2);
    expect(withoutLeak.stderr).toContain('invalid extra pattern');
    expect(withoutLeak.stderr).not.toContain('private-marker');
  });

  it('checks every commit in a --range and names the leaking one', () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'docs: clean change');
    const cleanSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'fix: tidy', '-m', 'Built in /home/me/mailoo');
    const leakSha = git(repo, 'rev-parse', 'HEAD');
    const env = { PUBLIC_GIT_DENYLIST_FILE: join(repo, 'none') };
    expect(runChecker(['--range', `${base}..${cleanSha}`], repo, env)).toEqual({
      status: 0,
      stderr: '',
    });
    const result = runChecker(['--range', `${base}..${leakSha}`], repo, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(leakSha);
    expect(result.stderr).not.toContain(cleanSha);
  });

  it('scans the commit subject in --range mode', () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    git(
      repo,
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'fix: path /home/me/mailoo',
      '-m',
      'Clean body.',
    );
    const leakSha = git(repo, 'rev-parse', 'HEAD');
    const result = runChecker(['--range', `${base}..${leakSha}`], repo, {
      PUBLIC_GIT_DENYLIST_FILE: join(repo, 'none'),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(leakSha);
  });

  it('fails on a --range git cannot resolve', () => {
    const repo = initRepo();
    const result = runChecker(['--range', 'no-such-ref..HEAD'], repo, {
      PUBLIC_GIT_DENYLIST_FILE: join(repo, 'none'),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cannot list commits');
  });

  it('rejects a --file that does not exist with usage', () => {
    const dir = makeTmpDir('mailoo-public-git-absent-');
    const result = runChecker(['--file', join(dir, 'absent')], dir, {
      PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });

  it('fails closed when grep itself errors', () => {
    const dir = makeTmpDir('mailoo-public-git-grep-');
    const shim = join(dir, 'grep');
    writeFileSync(shim, '#!/bin/sh\nexit 2\n');
    chmodSync(shim, 0o755);
    const msg = join(dir, 'MSG');
    writeFileSync(msg, clean);
    const result = runChecker(['--file', msg], dir, {
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('grep failed');
  });

  it('rejects a missing mode with usage', () => {
    const dir = makeTmpDir('mailoo-public-git-usage-');
    const result = runChecker([], dir, { PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none') });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage:');
  });
});
