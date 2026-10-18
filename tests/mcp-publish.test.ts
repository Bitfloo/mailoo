import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { releaseStep, releaseYml, runBlock, runStep } from './workflow-yaml.js';

const installStep = releaseStep(releaseYml, 'Install mcp-publisher');
const publishStep = releaseStep(releaseYml, 'Publish to MCP Registry');

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

interface Publisher {
  /** What every failed call prints: the registry's npm 404 reply or another error. */
  error: 'npm' | 'other';
  /** The exit status of every failed call. */
  status: number;
  stream?: 'stdout' | 'stderr';
  /** The call that succeeds; none when left out. */
  succeedsOn?: number;
}

/** Run the publish step against a fake mcp-publisher; return its exit status, the calls and each pause. */
function publish(publisher: Publisher): { status: number | null; calls: number; pauses: string[] } {
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

describe('MCP Registry publish', () => {
  it('should exit 0 after one call when mcp-publisher succeeds', () => {
    expect(publish({ error: 'other', status: 1, succeedsOn: 1 })).toEqual({
      status: 0,
      calls: 1,
      pauses: [],
    });
  });

  it("should exit with the publisher's status after one call when the error is not npm's", () => {
    expect(publish({ error: 'other', status: 3 })).toEqual({ status: 3, calls: 1, pauses: [] });
  });

  it('should call mcp-publisher six times, 20 seconds apart, and fail when npm never shows the version', () => {
    expect(publish({ error: 'npm', status: 7 })).toEqual({
      status: 7,
      calls: 6,
      pauses: ['20', '20', '20', '20', '20'],
    });
  });

  it('should retry when the npm message arrives on stderr', () => {
    expect(publish({ error: 'npm', status: 7, stream: 'stderr', succeedsOn: 3 })).toEqual({
      status: 0,
      calls: 3,
      pauses: ['20', '20'],
    });
  });

  it('should pin the mcp-publisher archive hash in the install step', () => {
    expect(installStep).not.toContain('releases/latest');
    expect(installStep).toMatch(/\b[0-9a-f]{64}\b/);
  });

  it('should stop the release when the mcp-publisher archive hash does not match', () => {
    const temp = mkdtempSync(join(tmpdir(), 'mailoo-mcp-install-'));
    try {
      // A valid archive with the wrong hash, so only the hash check can stop the step.
      mkdirSync(join(temp, 'payload'));
      script(join(temp, 'payload/mcp-publisher'), ['exit 0']);
      runStep('tar -czf wrong.tar.gz -C payload mcp-publisher', temp, { PATH: process.env.PATH });
      mkdirSync(join(temp, 'bin'));
      script(join(temp, 'bin/curl'), [
        'while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done',
        'cp wrong.tar.gz "$out"',
      ]);
      const { status } = runStep(runBlock(installStep), temp, {
        PATH: `${join(temp, 'bin')}:${process.env.PATH}`,
      });
      expect({ status, extracted: existsSync(join(temp, 'mcp-publisher')) }).toEqual({
        status: 1,
        extracted: false,
      });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
