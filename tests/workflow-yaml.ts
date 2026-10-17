import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { repoRoot } from './agents/agent-file.js';

export const workflowDir = join(repoRoot, '.github/workflows');

export const releaseYml = readFileSync(join(workflowDir, 'release.yml'), 'utf8');

export function onBlock(yaml: string): string {
  const match = yaml.match(/^on:\n([\s\S]*?)\n(?:concurrency|permissions|jobs):/m);
  if (!match) {
    throw new Error('missing on: block');
  }
  return match[1];
}

/** Job keys are indented, so a column-0 match stays on the workflow permissions. */
export function topLevelPermissions(yaml: string): string {
  const match = yaml.match(/^permissions:[^\n]*(?:\n {2}[^\n]*)*/m);
  if (!match) {
    throw new Error('missing top-level permissions');
  }
  return match[0];
}

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

/** The step's `env:` block with each `${{ expression }}` filled in from `context`, as the runner does. */
export function stepEnv(step: string, context: Record<string, string>): Record<string, string> {
  const block = step.match(/\n {8}env:\n((?: {10}\S.*\n)+)/)?.[1] ?? '';
  return Object.fromEntries(
    [...block.matchAll(/^ {10}(\w+): (.*)$/gm)].map(([, name, value]) => [
      name,
      value.replace(/\$\{\{ ([\w.-]+) \}\}/g, (_, expression: string) => {
        // A dispatch input has two spellings; both are empty on a tag push.
        const key = expression.replace(/^github\.event\.inputs\./, 'inputs.');
        if (!(key in context)) {
          throw new Error(`no value for ${expression}`);
        }
        return context[key];
      }),
    ]),
  );
}

/** The ref variables the runner sets together, so a step may read either form. */
export function refEnv(ref: string): { GITHUB_REF: string; GITHUB_REF_NAME: string } {
  return { GITHUB_REF: ref, GITHUB_REF_NAME: ref.replace(/^refs\/(?:heads|tags)\//, '') };
}

/** One chunk per job so a token can be required on the scorecard job only. */
export function jobSections(yaml: string): string[] {
  const parts = yaml.split(/^jobs:\n/m);
  if (parts.length < 2) {
    throw new Error('missing jobs');
  }
  return parts[1].split(/\n(?= {2}[a-zA-Z0-9_-]+:\n)/);
}
