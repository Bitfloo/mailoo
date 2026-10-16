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
    expect(scanFile(clean, { PUBLIC_GIT_DENYLIST_FILE: list })).toEqual({
      status: 2,
      stdout: '',
      stderr: `public-git: invalid extra pattern in ${list} line 3\n`,
    });
  });

  const malformedSources: [
    string,
    (dir: string) => { env: Record<string, string>; where: string; pattern: string },
  ][] = [
    [
      'the environment',
      (dir) => ({
        env: {
          PUBLIC_GIT_EXTRA_FORBIDDEN: '(private-marker-env',
          PUBLIC_GIT_DENYLIST_FILE: join(dir, 'none'),
        },
        where: 'PUBLIC_GIT_EXTRA_FORBIDDEN',
        pattern: '(private-marker-env',
      }),
    ],
    [
      'the denylist file',
      () => {
        const list = denylist('example-private-tree\nprivate-marker-list(\n');
        return {
          env: { PUBLIC_GIT_DENYLIST_FILE: list },
          where: `${list} line 2`,
          pattern: 'private-marker-list(',
        };
      },
    ],
  ];

  it.each(
    malformedSources,
  )('fails closed on a malformed extra pattern from %s and names only its source', (_source, make) => {
    const { env, where } = make(makeTmpDir('mailoo-public-git-bad-'));
    expect(scanFile(clean, env)).toEqual({
      status: 2,
      stdout: '',
      stderr: `public-git: invalid extra pattern in ${where}\n`,
    });
  });

  it.each(
    malformedSources,
  )('still echoes a built-in hit beside a malformed extra pattern from %s', (_source, make) => {
    const dir = makeTmpDir('mailoo-public-git-bad-');
    const { env, where } = make(dir);
    const msg = join(dir, 'MSG');
    writeFileSync(msg, leak);
    expect(runChecker(['--file', msg], dir, env)).toEqual({
      status: 2,
      stdout: '',
      stderr:
        `public-git: invalid extra pattern in ${where}\n` +
        leak +
        `public-git: forbidden token in ${msg} (see .claude/rules/public-git.md)\n`,
    });
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
    expect(result).toEqual({
      status: 2,
      stdout: '',
      stderr:
        'public-git: invalid extra pattern in PUBLIC_GIT_EXTRA_FORBIDDEN\n' +
        'fix: path /home/me/two\n' +
        `public-git: forbidden token in ${second} (see .claude/rules/public-git.md)\n` +
        'fix: path /Users/me/one\n' +
        `public-git: forbidden token in ${first} (see .claude/rules/public-git.md)\n`,
    });
  });

  it.each(
    malformedSources,
  )('keeps a malformed pattern from %s out of stderr even when grep echoes it', (_source, make) => {
    const dir = makeTmpDir('mailoo-public-git-echo-');
    const { env, where, pattern } = make(dir);
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
      ...env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      GREP_SHIM_REAL: realGrep,
      GREP_SHIM_LOG: log,
    });
    expect(readFileSync(log, 'utf8').split('\n')).toContainEqual(expect.stringContaining(pattern));
    expect(result).toEqual({
      status: 2,
      stdout: '',
      stderr: `public-git: invalid extra pattern in ${where}\n`,
    });
  });
});
