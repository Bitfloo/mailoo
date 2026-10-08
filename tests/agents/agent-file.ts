import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const repoRoot = join(import.meta.dirname, '../..');

export const USER_DESCRIPTION_MAX_CHARS = 800;
export const SYSTEM_PROMPT_MAX_WORDS = 500;

/** Cursor subagent floor for test-auditor / test-smith (see `.cursor/agents/` frontmatter). */
export const CURSOR_TEST_AGENT_MODEL = 'cursor-grok-4.6-xhigh';

export const CLAUDE_TEST_AGENT_MODEL = 'sonnet';

/** Twins differ only by host `model:` — body and routing must stay aligned. */
export function agentTwinBody(text: string): string {
  return text.replace(/^model: .+\n/m, '');
}

export function readTwinAgent(name: string): { claude: string; cursor: string } {
  return {
    claude: readFileSync(join(repoRoot, '.claude/agents', `${name}.md`), 'utf8'),
    cursor: readFileSync(join(repoRoot, '.cursor/agents', `${name}.md`), 'utf8'),
  };
}

export function descriptionBlock(text: string): string {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    return '';
  }
  const desc = match[1].match(/^description:\s*\|\n([\s\S]*?)(?=^[a-zA-Z]+:)/m);
  return desc ? desc[1].replace(/^ {2}/gm, '').trim() : '';
}

export function toolsList(text: string): string[] {
  const match = text.match(/^tools:\n((?: {2}- .+\n)+)/m);
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/- (\S+)/g)].map((row) => row[1]);
}

export function systemPromptWords(text: string): string[] {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  // Generated-prompt cap excludes When-to-invoke examples (quality-thresholds agent-build loop).
  const withoutExamples = body.replace(/## When to invoke[\s\S]*$/, '');
  return withoutExamples.trim().split(/\s+/).filter(Boolean);
}

/** The checker's built-in leak pattern, read from the script so the tests cannot drift from it. */
export function checkerBuiltinPattern(): RegExp {
  const src = readFileSync(join(repoRoot, 'scripts/check-public-git-log.sh'), 'utf8');
  const match = src.match(/^BUILTIN='([^']+)'/m);
  if (!match) {
    throw new Error('BUILTIN pattern missing from scripts/check-public-git-log.sh');
  }
  return new RegExp(match[1], 'i');
}

/** Quoted phrases on the `Trigger:` line of a description block. */
export function triggerPhrases(description: string): string[] {
  const line = description.match(/^Trigger: (.+)$/m)?.[1] ?? '';
  return [...line.matchAll(/"([^"]+)"/g)].map((row) => row[1]);
}

/** Bodies of the `<example>` blocks under When to invoke. */
export function exampleBlocks(text: string): string[] {
  return [...text.matchAll(/<example>([\s\S]*?)<\/example>/g)].map((row) => row[1]);
}

/** Public agent text is English: no Polish letters and no common Polish request words. */
export const POLISH_TEXT = /[ąćęłńóśźż]|\b(testy|testów|napisz|sprawdź|sprawdz|oceń|ocen|czy)\b/i;
