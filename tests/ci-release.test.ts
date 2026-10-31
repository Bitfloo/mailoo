import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';

function runGate(requireIntegration: boolean, dockerStatus: number, integrationStatus = 0) {
  const root = mkdtempSync(join(tmpdir(), 'mailoo-release-gate-'));
  const calls = join(root, 'calls');
  try {
    writeFileSync(calls, '');
    writeFileSync(join(root, 'docker'), '#!/bin/sh\nexit "$FAKE_DOCKER_STATUS"\n', { mode: 0o755 });
    writeFileSync(
      join(root, 'pnpm'),
      `#!/bin/sh
echo "$*" >> "$GATE_CALLS"
if [ "$1" = "test:integration" ] && [ "$FAKE_INTEGRATION_STATUS" != "0" ]; then
  echo "Could not find a working container runtime strategy"
  exit "$FAKE_INTEGRATION_STATUS"
fi
`,
      { mode: 0o755 },
    );
    const result = spawnSync(
      'bash',
      [
        join(repoRoot, 'scripts/ci-local.sh'),
        ...(requireIntegration ? ['--require-integration'] : []),
      ],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          PATH: [root, process.env.PATH].join(delimiter),
          HOME: root,
          TMPDIR: root,
          GATE_CALLS: calls,
          FAKE_DOCKER_STATUS: String(dockerStatus),
          FAKE_INTEGRATION_STATUS: String(integrationStatus),
        },
      },
    );
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      calls: readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('release verification runtime requirement', () => {
  it('should fail before checks when required integration has no working Docker daemon', () => {
    const result = runGate(true, 1);
    expect(result.status).toBe(1);
    expect(result.output).toContain('required integration tests need a working Docker runtime');
    expect(result.calls).toEqual([]);
  });

  it('should preserve local checks without Docker when integration is optional', () => {
    const result = runGate(false, 1);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(['check', 'typecheck', 'test']);
    expect(result.output).toContain('skip integration');
  });

  it('should fail a release when Docker answers but the container runtime cannot start', () => {
    const result = runGate(true, 0, 23);
    expect(result.status).toBe(23);
    expect(result.calls).toEqual(['check', 'typecheck', 'test', 'test:integration']);
    expect(result.output).not.toContain('skip integration');
  });

  it('should accept a release only after the required integration command succeeds', () => {
    const result = runGate(true, 0);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(['check', 'typecheck', 'test', 'test:integration']);
  });
});
