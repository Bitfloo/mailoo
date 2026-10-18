import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Harness,
  harnessedStep,
  refEnv,
  runBlock,
  runStep,
  stepEnv,
} from './workflow-yaml.js';

export const mcpHarness: Harness = {
  workflow: 'release.yml',
  job: 'mcp',
  steps: ['Install mcp-publisher', 'Set version in server.json', 'Publish to MCP Registry'],
};

export const installStep = harnessedStep(mcpHarness, 'Install mcp-publisher');
const stampStep = harnessedStep(mcpHarness, 'Set version in server.json');
const publishStep = harnessedStep(mcpHarness, 'Publish to MCP Registry');

/**
 * The registry's reply when npm 404s a version it has just published, worded as npmVersion404Error
 * in https://github.com/modelcontextprotocol/registry/blob/v1.8.1/internal/validators/registries/npm.go
 * A literal, not the workflow's grep operand, so a typo in that operand fails here, not in a release.
 */
const npmNotShownYet =
  "NPM package '@bitfloo/mailoo' exists, but version '1.4.2' was not found (status: 404). " +
  'A newly published release can take a moment to appear on the registry. ' +
  "Wait and retry, or publish version '1.4.2' before registering it";

function script(path: string, lines: string[]): void {
  writeFileSync(path, `#!/bin/bash\n${lines.join('\n')}\n`, { mode: 0o755 });
}

export interface Publisher {
  /** What every failed call prints: the registry's npm 404 reply or another error. */
  error: 'npm' | 'other';
  /** The exit status of every failed call. */
  status: number;
  stream?: 'stdout' | 'stderr';
  /** The call that succeeds; none when left out. */
  succeedsOn?: number;
}

/** Run the publish step against a fake mcp-publisher; return its exit status, the calls and each pause. */
export function publish(publisher: Publisher): {
  status: number | null;
  calls: number;
  pauses: string[];
} {
  const temp = mkdtempSync(join(tmpdir(), 'mailoo-mcp-publish-'));
  try {
    const message = publisher.error === 'npm' ? npmNotShownYet : 'unauthorized';
    writeFileSync(join(temp, 'message'), `Error: ${message}\n`);
    writeFileSync(join(temp, 'calls'), '0');
    writeFileSync(join(temp, 'pauses'), '');
    script(join(temp, 'mcp-publisher'), [
      'n=$(($(cat calls) + 1)); echo "$n" > calls',
      `if [ "$n" -eq ${publisher.succeedsOn ?? 0} ]; then exit 0; fi`,
      `cat message >&${publisher.stream === 'stderr' ? 2 : 1}`,
      `exit ${publisher.status}`,
    ]);
    mkdirSync(join(temp, 'bin'));
    // The step pauses between attempts; the shim records each pause instead of waiting it out.
    script(join(temp, 'bin/sleep'), ['echo "$1" >> pauses']);
    const { status } = runStep(runBlock(publishStep), temp, {
      PATH: `${join(temp, 'bin')}:${process.env.PATH}`,
      TMPDIR: temp,
    });
    const read = (name: string) => readFileSync(join(temp, name), 'utf8');
    return {
      status,
      calls: Number(read('calls')),
      pauses: read('pauses').split('\n').filter(Boolean),
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

/** Run the server.json stamp step with a stamp script that prints the version it is handed. */
export function stamp(
  ref: string,
  inputVersion: string,
): { status: number | null; stdout: string } {
  const temp = mkdtempSync(join(tmpdir(), 'mailoo-server-json-step-'));
  try {
    mkdirSync(join(temp, 'scripts'));
    writeFileSync(join(temp, 'scripts/bump-server-json-version.sh'), 'printf "%s\\n" "$1"\n');
    const { status, stdout } = runStep(runBlock(stampStep), temp, {
      PATH: process.env.PATH,
      ...refEnv(ref),
      ...stepEnv(stampStep, { 'inputs.version': inputVersion }),
    });
    return { status, stdout };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
