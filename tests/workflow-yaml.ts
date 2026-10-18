import { spawnSync } from 'node:child_process';
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { isNode, isScalar, LineCounter, parse, parseDocument, visit } from 'yaml';

import { repoRoot } from './agents/agent-file.js';

export const workflowDir = join(repoRoot, '.github/workflows');

/** Every workflow file name. GitHub runs .yaml files too, so a check over all workflows reads both. */
export function workflowFiles(dir = workflowDir): string[] {
  const files = readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  if (files.length === 0) {
    throw new Error('no workflow files');
  }
  return files;
}

export function workflowTexts(): (readonly [string, string])[] {
  return workflowFiles().map(
    (name) => [name, readFileSync(join(workflowDir, name), 'utf8')] as const,
  );
}

export const releaseYml = readFileSync(join(workflowDir, 'release.yml'), 'utf8');

interface WorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  'working-directory'?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

/**
 * Parsed, while the readers beside it scan text: the checks built on it compare step values (a
 * with: input, a run command, a node-version), which YAML writes plain, quoted, folded or in a
 * flow mapping, and only the parser reads each form as the runner does. The text readers check
 * where a key is written, which the parsed tree no longer shows.
 */
export function jobSteps(yaml: string): Record<string, WorkflowStep[]> {
  const { jobs } = parse(yaml) as { jobs: Record<string, { steps?: WorkflowStep[] }> };
  return Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, job.steps ?? []]));
}

export function onBlock(yaml: string): string {
  const match = yaml.match(/^on:\n([\s\S]*?)\n(?:concurrency|permissions|jobs):/m);
  if (!match) {
    throw new Error('missing on: block');
  }
  return match[1];
}

/** Each line of the on: block above the trigger settings, as written, so a trigger in any form is listed. */
export function triggers(yaml: string): string[] {
  return releaseSteps(onBlock(yaml)).match(/^ {0,2}\S.*$/gm) ?? [];
}

/** Comment lines are stripped so a workflow comment mentioning a forbidden string does not trip the content assertions. */
export function releaseSteps(yaml: string): string {
  return yaml
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/**
 * Each line outside a comment that sets `key` (or any key of an `a|b` list), plain, quoted or in a
 * flow mapping, listed once per time a key occurs. Text that only looks like the key is listed
 * too, so a check built on this fails on a form it did not expect instead of missing it.
 */
function keyLines(yaml: string, key: string): string[] {
  const pattern = new RegExp(`(?<![\\w-])(["']?)(?:${key})\\1[ \\t]*:`, 'g');
  return releaseSteps(yaml)
    .split('\n')
    .flatMap((line) => Array.from(line.matchAll(pattern), () => line));
}

/**
 * Each line where the YAML parser reads a key that keyLines would not find written there: an
 * escaped or explicit key, a key whose colon sits on another line, a key that is not a plain
 * value, or an alias anywhere, which repeats keys the text readers see only at the anchor.
 * The regex reader and the parser must agree on every key: a key the runner reads in a form the
 * regex misses would carry a banned key past every check built on keyLines, so readKeyLines
 * refuses the whole text rather than read it without that key. No workflow writes a key in such
 * a form today.
 */
export function unreadKeys(yaml: string): string[] {
  const lineCounter = new LineCounter();
  const doc = parseDocument(yaml, { lineCounter });
  if (doc.errors.length > 0) {
    throw doc.errors[0];
  }
  const unread = new Set<number>();
  const flag = (node: unknown) => {
    unread.add(lineCounter.linePos(isNode(node) ? (node.range?.[0] ?? 0) : 0).line);
  };
  visit(doc, {
    Alias: (_, node) => flag(node),
    Pair: (_, { key, value }) => {
      if (!isScalar(key)) {
        flag(isNode(key) ? key : value);
        return;
      }
      const [start, end] = key.range ?? [0, 0];
      const written = yaml.slice(start, end) + (yaml.slice(end).match(/^[ \t]*:/)?.[0] ?? '');
      const name = String(key.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (keyLines(written, name).length !== 1) {
        flag(key);
      }
    },
  });
  const lines = yaml.split('\n');
  return [...unread].sort((a, b) => a - b).map((line) => lines[line - 1].trim());
}

/** keyLines, after refusing a text that holds a key the YAML parser reads and keyLines would miss. */
export function readKeyLines(yaml: string, key: string): string[] {
  const unread = unreadKeys(yaml);
  if (unread.length > 0) {
    throw new Error(`keys the text readers cannot see: ${unread.join(' | ')}`);
  }
  return keyLines(yaml, key);
}

/** The steps of one workflow job that a harness module runs against fakes, by name or id. */
export interface Harness {
  workflow: string;
  job: string;
  steps: readonly string[];
}

/**
 * The text of a step the harness declares, read from the harness's own job, so a step of the same
 * name in another job is not run in its place.
 */
export function harnessedStep(harness: Harness, label: string): string {
  const where = `${harness.workflow} ${harness.job}`;
  if (!harness.steps.includes(label)) {
    throw new Error(`${where}: the harness does not declare ${label}`);
  }
  const yaml = readFileSync(join(workflowDir, harness.workflow), 'utf8');
  const job = jobSections(yaml).find((section) => section.startsWith(`  ${harness.job}:\n`));
  const step = jobSteps(yaml)[harness.job]?.find((s) => s.name === label || s.id === label);
  if (!job || !step) {
    throw new Error(`${where} has no step ${label}`);
  }
  return releaseStep(job, label, step.name === label ? 'name' : 'id');
}

/** The release.yml job that holds `marker`, comment lines stripped. */
export function releaseJob(marker: string): string {
  const job = jobSections(releaseSteps(releaseYml)).find((section) => section.includes(marker));
  if (!job) {
    throw new Error(`no release job holds ${marker.trim()}`);
  }
  return job;
}

/** Isolate one step, found by its name or id, so a hash elsewhere cannot satisfy the install check. */
export function releaseStep(yaml: string, name: string, key: 'name' | 'id' = 'name'): string {
  const steps = releaseSteps(yaml);
  const marker = `- ${key}: ${name}\n`;
  const start = steps.indexOf(marker);
  if (start < 0) {
    throw new Error(`missing step ${name}`);
  }
  // From the line start, so the step's own indent keeps it readable as YAML. It ends at the next
  // step or job, so the last step of a job does not run on into the next one.
  const rest = steps.slice(steps.lastIndexOf('\n', start) + 1);
  const body = rest.indexOf(marker) + marker.length;
  const next = rest.slice(body).search(/\n {0,6}\S/);
  return next < 0 ? rest : rest.slice(0, body + next);
}

/** The step's `env:` block with each `${{ expression }}` filled in from `context`, as the runner does. */
export function stepEnv(step: string, context: Record<string, string>): Record<string, string> {
  const block = step.match(/\n {8}env:\n((?: {10}\S.*\n)+)/)?.[1] ?? '';
  return Object.fromEntries(
    [...block.matchAll(/^ {10}(\w+): (.*)$/gm)].map(([, name, value]) => [
      name,
      value.replace(/\$\{\{ ([\w.-]+) \}\}/g, (_, expression: string) => {
        if (!(expression in context)) {
          throw new Error(`no value for ${expression}`);
        }
        return context[expression];
      }),
    ]),
  );
}

/**
 * The step's command as the runner executes it: a one-line `run:`, or a `run: |` block dedented.
 * A step that sets shell: or working-directory: is refused, since runStep would run other code.
 */
export function runBlock(step: string): string {
  const unmodelled = readKeyLines(step, 'shell|working-directory');
  if (unmodelled.length > 0) {
    throw new Error(
      `the harness runs bash -e in the checkout, not: ${unmodelled.join(' | ').trim()}`,
    );
  }
  const line = step.match(/^ {8}run: (?![|>])(.+)$/m)?.[1];
  if (line) {
    return line;
  }
  const block = step.match(/\n {8}run: \|\n((?: {10}.*(?:\n|$)|\n)+)/)?.[1];
  if (!block) {
    throw new Error('step has no run command');
  }
  return block.replace(/^ {10}/gm, '');
}

/** Run a command as the runner runs a step without `shell:` (`bash -e {0}`: no -u, no pipefail), with only `env`. */
export function runStep(command: string, cwd: string, env: Record<string, string | undefined>) {
  return spawnSync('bash', ['-e', '-c', command], { cwd, env, encoding: 'utf8' });
}

/**
 * Throw once, naming every tool `path` does not hold as an executable, so a machine without one
 * fails with that name instead of a step's exit status 127. Nothing is installed.
 */
export function requireTools(tools: string[], path = process.env.PATH ?? ''): void {
  const onPath = (tool: string) =>
    path.split(delimiter).some((dir) => {
      try {
        accessSync(join(dir, tool), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  const missing = tools.filter((tool) => !onPath(tool));
  if (missing.length > 0) {
    throw new Error(`these tests need ${missing.join(', ')} on PATH`);
  }
}

/**
 * One chunk per job so a token can be required on the scorecard job only. Throws unless every
 * job key in the block starts a chunk, so a key form it cannot split on does not hide a job.
 */
export function jobSections(yaml: string): string[] {
  const parts = yaml.split(/^jobs:\n/m);
  if (parts.length < 2) {
    throw new Error('missing jobs');
  }
  const keys = parts[1].match(/^ {2}[^\s#]/gm)?.length ?? 0;
  const sections = parts[1].split(/\n(?= {2}(?:[\w-]+|"[^"\n]+"|'[^'\n]+'):[ \t]*(?:#.*)?\n)/);
  if (sections.length !== keys) {
    throw new Error(`read ${sections.length} of ${keys} jobs`);
  }
  return sections;
}
