import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const repoRoot = join(import.meta.dirname, '../..');

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
