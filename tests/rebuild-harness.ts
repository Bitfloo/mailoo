import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { releaseStep, runBlock, runStep, workflowDir } from './workflow-yaml.js';

export const rebuildYml = readFileSync(join(workflowDir, 'docker-rebuild.yml'), 'utf8');

/** Run the meta step in a checkout holding `manifest` as package.json; return its status, stderr and outputs. */
export function meta(manifest: object) {
  const run = runBlock(releaseStep(rebuildYml, 'meta', 'id'));
  const temp = mkdtempSync(join(tmpdir(), 'mailoo-docker-rebuild-'));
  try {
    writeFileSync(join(temp, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(temp, 'output'), '');
    const { status, stderr } = runStep(run, temp, {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: join(temp, 'output'),
    });
    const lines = readFileSync(join(temp, 'output'), 'utf8').split('\n').filter(Boolean);
    const outputs = Object.fromEntries(
      lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    return { status, stderr, outputs };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
