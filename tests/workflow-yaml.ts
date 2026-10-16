import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';

export const releaseYml = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');

/** Comment lines are stripped so a workflow comment mentioning a forbidden string does not trip the content assertions. */
export function releaseSteps(yaml: string): string {
  return yaml
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/** Isolate one step so a hash elsewhere cannot satisfy the install check. */
export function releaseStep(yaml: string, name: string): string {
  const steps = releaseSteps(yaml);
  const marker = `- name: ${name}\n`;
  const start = steps.indexOf(marker);
  if (start < 0) {
    throw new Error(`missing step ${name}`);
  }
  const rest = steps.slice(start);
  const next = rest.indexOf('\n      - ', marker.length);
  return next < 0 ? rest : rest.slice(0, next);
}

/** One chunk per job so a token can be required on the scorecard job only. */
export function jobSections(yaml: string): string[] {
  const parts = yaml.split(/^jobs:\n/m);
  if (parts.length < 2) {
    throw new Error('missing jobs');
  }
  return parts[1].split(/\n(?= {2}[a-zA-Z0-9_-]+:\n)/);
}
