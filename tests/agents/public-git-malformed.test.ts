import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  clean,
  denylist,
  git,
  initRepo,
  leak,
  makeTmpDir,
  removeTmpDirs,
  runChecker,
  scanFile,
} from './public-git-checker.js';

afterEach(removeTmpDirs);

describe('public git checker: malformed private patterns', () => {
  it('reports the physical file line of a malformed denylist pattern', () => {
    const list = denylist('\n# private patterns\nprivate-marker-three(\n');
    const result = scanFile(clean, { PUBLIC_GIT_DENYLIST_FILE: list });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('public-git-denylist line 3');
  });

  it.each([
    [
      'the environment',
      'invalid extra pattern in PUBLIC_GIT_EXTRA_FORBIDDEN',
      (dir: string) => ({
        PUBLIC_GIT_EXTRA_FORBIDDEN: '(private-marker-env',
        PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
      }),
    ],
    [
      'the denylist file',
      'public-git-denylist line 2',
      () => ({
        PUBLIC_GIT_DENYLIST_FILE: denylist('example-private-tree\nprivate-marker-list(\n'),
      }),
    ],
  ])('fails closed on a malformed extra pattern from %s', (_source, where, makeEnv) => {
    const env = makeEnv(makeTmpDir('mailoo-public-git-bad-'));
    const withLeak = scanFile(leak, env);
    expect(withLeak.status).toBe(2);
    expect(withLeak.stderr).toContain('invalid extra pattern');
    expect(withLeak.stderr).toContain(where);
    expect(withLeak.stderr).toContain('/Users/me/mailoo');
    expect(withLeak.stderr).not.toContain('private-marker');
    const withoutLeak = scanFile(clean, env);
    expect(withoutLeak.status).toBe(2);
    expect(withoutLeak.stderr).toContain('invalid extra pattern');
    expect(withoutLeak.stderr).not.toContain('private-marker');
  });

  it('keeps scanning after a malformed extra pattern in --file mode', () => {
    const dir = makeTmpDir('mailoo-public-git-bad-file-');
    const result = scanFile('fix: path /Users/me/one\n\nAlso /home/me/two\n', {
      PUBLIC_GIT_EXTRA_FORBIDDEN: '(private-marker-env',
      PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('invalid extra pattern in PUBLIC_GIT_EXTRA_FORBIDDEN');
    expect(result.stderr).toContain('fix: path /Users/me/one');
    expect(result.stderr).toContain('Also /home/me/two');
    expect(result.stderr).toContain('forbidden token');
  });

  it('keeps scanning every commit after a malformed extra pattern in --range mode', () => {
    const repo = initRepo();
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'fix: path /Users/me/one');
    const first = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'fix: path /home/me/two');
    const second = git(repo, 'rev-parse', 'HEAD');
    const result = runChecker(['--range', `${base}..${second}`], repo, {
      PUBLIC_GIT_EXTRA_FORBIDDEN: '(private-marker-env',
      PUBLIC_GIT_DENYLIST_FILE: join(repo, 'none'),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`forbidden token in ${first}`);
    expect(result.stderr).toContain(`forbidden token in ${second}`);
  });

  it.each([
    [
      'the environment',
      '(private-marker-env',
      (_dir: string): Record<string, string> => ({
        PUBLIC_GIT_EXTRA_FORBIDDEN: '(private-marker-env',
      }),
      (_dir: string): string => 'PUBLIC_GIT_EXTRA_FORBIDDEN',
    ],
    [
      'the denylist file',
      'private-marker-list(',
      (dir: string): Record<string, string> => {
        const list = join(dir, 'public-git-denylist');
        writeFileSync(list, 'private-marker-list(\n');
        return { PUBLIC_GIT_DENYLIST_FILE: list };
      },
      (dir: string): string => `${join(dir, 'public-git-denylist')} line 1`,
    ],
  ])('keeps a malformed pattern from %s out of stderr even when grep echoes it', (_source, pattern, makeEnv, where) => {
    const dir = makeTmpDir('mailoo-public-git-echo-');
    const realGrep = spawnSync('sh', ['-c', 'command -v grep'], { encoding: 'utf8' }).stdout.trim();
    expect(realGrep.startsWith('/')).toBe(true);
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const shim = join(bin, 'grep');
    // Wraps the real grep and echoes any argument that carries the private marker,
    // the way a grep that quotes its pattern in an error message would.
    writeFileSync(
      shim,
      [
        '#!/bin/sh',
        'printf \'%s\\n\' "$*" >>"$GREP_SHIM_LOG"',
        'for arg in "$@"; do',
        '  case $arg in *private-marker*) printf \'grep: bad pattern %s\\n\' "$arg" >&2 ;; esac',
        'done',
        'exec "$GREP_SHIM_REAL" "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(shim, 0o755);
    const log = join(dir, 'grep-calls.log');
    const msg = join(dir, 'MSG');
    writeFileSync(msg, clean);
    const result = runChecker(['--file', msg], dir, {
      PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
      ...makeEnv(dir),
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GREP_SHIM_REAL: realGrep,
      GREP_SHIM_LOG: log,
    });
    expect(readFileSync(log, 'utf8').split('\n')).toContainEqual(expect.stringContaining(pattern));
    expect(result).toEqual({
      status: 2,
      stdout: '',
      stderr: `public-git: invalid extra pattern in ${where(dir)}\n`,
    });
  });
});
