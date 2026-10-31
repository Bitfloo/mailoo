import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';
import { type Harness, harnessedStep, runBlock, runStep, stepEnv } from './workflow-yaml.js';

export const mcpHarness: Harness = {
  workflow: 'release.yml',
  job: 'mcp',
  steps: ['Install mcp-publisher', 'Set version in server.json', 'Publish to MCP Registry'],
};

export const installStep = harnessedStep(mcpHarness, 'Install mcp-publisher');
const stampStep = harnessedStep(mcpHarness, 'Set version in server.json');
const publishStep = harnessedStep(mcpHarness, 'Publish to MCP Registry');

// Every wait is virtual; a broken shell loop must still terminate the fixture.
const PUBLISH_STEP_TIMEOUT_MS = 10_000;

/**
 * The registry's reply when npm 404s a version it has just published, worded as npmVersion404Error
 * in https://github.com/modelcontextprotocol/registry/blob/v1.8.1/internal/validators/registries/npm.go
 * A literal, not the workflow's grep operand, so a typo in that operand fails here, not in a release.
 */
export const npmNotShownYet =
  "NPM package '@bitfloo/mailoo' exists, but version '1.4.2' was not found (status: 404). " +
  'A newly published release can take a moment to appear on the registry. ' +
  "Wait and retry, or publish version '1.4.2' before registering it";

function script(path: string, lines: string[]): void {
  writeFileSync(path, `#!/bin/bash\n${lines.join('\n')}\n`, { mode: 0o755 });
}

export interface Publisher {
  /** What every failed call prints after `Error: `. */
  reply: string;
  /** The exit status of every failed call. */
  status: number;
  stream?: 'stdout' | 'stderr';
  /** The call that succeeds; none when left out. */
  succeedsOn?: number;
  /** Virtual seconds before the published version becomes available. */
  availableAfter?: number;
}

/**
 * Run the publish step against a fake mcp-publisher. Return its exit status, its stdout and stderr,
 * the calls, each call's arguments as `[arg]...`, each pause, and how many temp files the step
 * made through mktemp and left behind.
 */
export function publish(
  publisher: Publisher,
  command = runBlock(publishStep),
): {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: number;
  args: string[];
  pauses: string[];
  elapsedSeconds: number;
  temps: { made: number; left: number };
} {
  const temp = mkdtempSync(join(tmpdir(), 'mailoo-mcp-publish-'));
  try {
    writeFileSync(join(temp, 'message'), `Error: ${publisher.reply}\n`);
    writeFileSync(join(temp, 'calls'), '0');
    writeFileSync(join(temp, 'args'), '');
    writeFileSync(join(temp, 'pauses'), '');
    writeFileSync(join(temp, 'clock'), '0');
    script(join(temp, 'mcp-publisher'), [
      'n=$(($(<calls) + 1)); echo "$n" > calls',
      `printf '[%s]' "$@" >> args; echo >> args`,
      `if [ "$n" -eq ${publisher.succeedsOn ?? 0} ]; then exit 0; fi`,
      ...(publisher.availableAfter === undefined
        ? []
        : [`if [ "$(<clock)" -ge ${publisher.availableAfter} ]; then exit 0; fi`]),
      `cat message >&${publisher.stream === 'stderr' ? 2 : 1}`,
      `exit ${publisher.status}`,
    ]);
    mkdirSync(join(temp, 'bin'));
    // npm scans take minutes. Advance a fixture clock so the real loop pays that time without sleeping.
    script(join(temp, 'bin/sleep'), ['echo "$1" >> pauses', 'echo "$(($(<clock) + $1))" > clock']);
    // The real mktemp, found past this bin directory, with each file it makes recorded.
    writeFileSync(join(temp, 'temps'), '');
    script(join(temp, 'bin/mktemp'), [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell expansion, not a JS template
      'file=$(PATH="${PATH#*:}" mktemp "$@")',
      'echo "$file" >> temps',
      'echo "$file"',
    ]);
    const { status, stdout, stderr, error } = spawnSync('/bin/bash', ['-e', '-c', command], {
      cwd: temp,
      env: {
        PATH: `${join(temp, 'bin')}:/usr/bin:/bin`,
        HOME: temp,
        TMPDIR: temp,
        LANG: 'C',
        LC_ALL: 'C',
        TZ: 'UTC',
      },
      encoding: 'utf8',
      timeout: PUBLISH_STEP_TIMEOUT_MS,
    });
    if (error) throw error;
    const read = (name: string) => readFileSync(join(temp, name), 'utf8');
    const temps = read('temps').split('\n').filter(Boolean);
    return {
      status,
      stdout,
      stderr,
      calls: Number(read('calls')),
      args: read('args').split('\n').filter(Boolean),
      pauses: read('pauses').split('\n').filter(Boolean),
      elapsedSeconds: Number(read('clock')),
      temps: { made: temps.length, left: temps.filter((file) => existsSync(file)).length },
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Run the install step against a fake download of a real archive. With `hash: 'shimmed'` a
 * sha256sum shim passes any archive, so the step goes on to extract it.
 */
export function install(hash: 'checked' | 'shimmed'): {
  status: number | null;
  extracted: boolean;
} {
  const temp = mkdtempSync(join(tmpdir(), 'mailoo-mcp-install-'));
  try {
    // A valid archive with the wrong hash, so only the hash check can stop the step.
    mkdirSync(join(temp, 'payload'));
    script(join(temp, 'payload/mcp-publisher'), ['exit 0']);
    runStep('tar -czf archive.tar.gz -C payload mcp-publisher', temp, { PATH: process.env.PATH });
    mkdirSync(join(temp, 'bin'));
    script(join(temp, 'bin/curl'), [
      'while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done',
      'cp archive.tar.gz "$out"',
    ]);
    if (hash === 'shimmed') {
      script(join(temp, 'bin/sha256sum'), ['cat > /dev/null']);
    }
    const { status } = runStep(runBlock(installStep), temp, {
      PATH: `${join(temp, 'bin')}:${process.env.PATH}`,
    });
    return { status, extracted: existsSync(join(temp, 'mcp-publisher')) };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

interface ServerJson {
  version: string;
  packages: { version: string }[];
}

/**
 * Run the server.json stamp step through copies of the real stamp scripts, on the repository's
 * server.json with every version set to 0.0.0. Return the exit status and the version, then each
 * packages[].version, the step leaves in server.json.
 */
export function stamp(
  ref: string,
  inputVersion: string,
): { status: number | null; versions: string[] } {
  const temp = mkdtempSync(join(tmpdir(), 'mailoo-server-json-step-'));
  try {
    mkdirSync(join(temp, 'scripts'));
    for (const name of ['bump-server-json-version.sh', 'release-version.sh']) {
      copyFileSync(join(repoRoot, 'scripts', name), join(temp, 'scripts', name));
    }
    const server = JSON.parse(readFileSync(join(repoRoot, 'server.json'), 'utf8')) as ServerJson;
    server.version = '0.0.0';
    for (const entry of server.packages) {
      entry.version = '0.0.0';
    }
    writeFileSync(join(temp, 'server.json'), JSON.stringify(server));
    mkdirSync(join(temp, 'bin'));
    // ubuntu-latest runs sh as dash, which has neither source nor [[, so the shim does the same.
    script(join(temp, 'bin/sh'), ['exec dash "$@"']);
    const { status } = runStep(runBlock(stampStep), temp, {
      PATH: `${join(temp, 'bin')}:${process.env.PATH}`,
      GITHUB_REF: ref,
      ...stepEnv(stampStep, { 'inputs.version': inputVersion }),
    });
    const stamped = JSON.parse(readFileSync(join(temp, 'server.json'), 'utf8')) as ServerJson;
    return {
      status,
      versions: [stamped.version, ...stamped.packages.map((entry) => entry.version)],
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
