import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const repoRoot = join(import.meta.dirname, '../..');
export const doctrinePath = join(repoRoot, '.claude/rules/testing-doctrine.md');

export const USER_DESCRIPTION_MAX_CHARS = 800;
export const SYSTEM_PROMPT_MAX_WORDS = 500;

/** Cursor subagent floor for test-auditor / test-smith (see `.cursor/agents/` frontmatter). */
export const CURSOR_TEST_AGENT_MODEL = 'cursor-grok-4.6-xhigh';

export const CLAUDE_TEST_AGENT_MODEL = 'sonnet';

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
export function checkerBuiltinSource(): string {
  const src = readFileSync(join(repoRoot, 'scripts/check-public-git-log.sh'), 'utf8');
  const match = src.match(/^BUILTIN='([^']+)'/m);
  if (!match) {
    throw new Error('BUILTIN pattern missing from scripts/check-public-git-log.sh');
  }
  return match[1];
}

export function checkerBuiltinPattern(): RegExp {
  return new RegExp(checkerBuiltinSource(), 'i');
}

export function triggerPhrases(description: string): string[] {
  const line = description.match(/^Trigger: (.+)$/m)?.[1] ?? '';
  return [...line.matchAll(/"([^"]+)"/g)].map((row) => row[1]);
}

export function exampleBlocks(text: string): string[] {
  return [...text.matchAll(/<example>([\s\S]*?)<\/example>/g)].map((row) => row[1]);
}

/** Public agent text is English: no Polish letters and no common Polish request words. */
export const POLISH_TEXT = /[ąćęłńóśźż]|\b(testy|testów|napisz|sprawdź|sprawdz|oceń|ocen|czy)\b/i;

export function exampleUserLines(text: string): string[] {
  return exampleBlocks(text).map((block) => block.match(/^\s*user: "([^"]+)"$/m)?.[1] ?? '');
}

/** Wording that would grant an agent more than its rails allow. */
export const PERMISSION_GRANT =
  /\bmay (also )?(write|edit|fix|modify|change|stage|commit|install|push|delete)\b|\b(is|are) allowed to (write|edit|fix|modify)\b/i;

/** Checked-in expected text of a project agent, as its Claude Code copy (`model: sonnet`). */
export function expectedAgentText(name: string): string {
  return readFileSync(join(repoRoot, 'tests/agents/__fixtures__', `${name}.expected.md`), 'utf8');
}

/** Line numbers (0-based) where two texts differ; texts of different length differ at every extra line. */
export function differingLines(a: string, b: string): number[] {
  const left = a.split('\n');
  const right = b.split('\n');
  const out: number[] = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      out.push(i);
    }
  }
  return out;
}

/** `[lane, command]` rows of the doctrine's Two lanes table. */
export function doctrineRunners(): [string, string][] {
  const doctrine = readFileSync(doctrinePath, 'utf8');
  return [...doctrine.matchAll(/^\| (\w+) \| [^|]+ \| `([^`]+)` \|/gm)].map((row) => [
    row[1],
    row[2],
  ]);
}

/** `[rate, band]` pairs of the doctrine's detection-rate bands. */
export function doctrineDetectionBands(): [string, string][] {
  const doctrine = readFileSync(doctrinePath, 'utf8');
  return [...doctrine.matchAll(/\*\*([<>]?\d+(?:–\d+)?%)\*\*\s+([a-z]+(?: [a-z]+)?)/g)].map(
    (row) => [row[1], row[2]],
  );
}

/** The lowest test-auditor score the doctrine ships at. */
export function doctrineShipBarScore(): string {
  return (
    /\*\*score ≥ (\d+)\*\* and zero CRITICAL/.exec(readFileSync(doctrinePath, 'utf8'))?.[1] ?? ''
  );
}

/** Checks every project test agent shares; call inside that agent's describe. */
export function agentFileContract(name: string, exampleCount: number): void {
  const { claude, cursor } = readTwinAgent(name);
  const expected = expectedAgentText(name);

  it('matches the checked-in agent text word for word in the Claude Code copy', () => {
    expect(claude).toBe(expected);
  });

  it('matches the checked-in agent text word for word in the Cursor copy, except the model line', () => {
    const modelLine = expected.split('\n').indexOf(`model: ${CLAUDE_TEST_AGENT_MODEL}`);
    expect(modelLine).toBeGreaterThan(0);
    expect(differingLines(expected, cursor)).toEqual([modelLine]);
    expect(cursor.split('\n')[modelLine]).toBe(`model: ${CURSOR_TEST_AGENT_MODEL}`);
  });

  it('stays inside the user-class description budget', () => {
    expect(descriptionBlock(claude).length).toBeGreaterThan(10);
    expect(descriptionBlock(claude).length).toBeLessThanOrEqual(USER_DESCRIPTION_MAX_CHARS);
  });

  it('keeps the generated system prompt (excluding When to invoke) inside the 500-word cap', () => {
    expect(systemPromptWords(claude).length).toBeLessThanOrEqual(SYSTEM_PROMPT_MAX_WORDS);
  });

  it('does not cite anything the public git checker forbids, or a home path', () => {
    for (const text of [claude, cursor]) {
      expect(text).not.toMatch(checkerBuiltinPattern());
      expect(text).not.toMatch(/(^|[\s`("'])~\//m);
    }
  });

  it('keeps the agent text English-only', () => {
    for (const text of [claude, cursor]) {
      expect(text).not.toMatch(POLISH_TEXT);
    }
  });

  it('gives each When to invoke example a context, a user request, and an answer', () => {
    const examples = exampleBlocks(claude);
    expect(examples).toHaveLength(exampleCount);
    for (const example of examples) {
      expect(example).toMatch(/^\s*Context: \S/m);
      expect(example).toMatch(/^\s*user: "[^"]+"$/m);
      expect(example).toMatch(/^\s*assistant: "[^"]+"$/m);
    }
  });

  it('never grants extra permissions anywhere in the agent file', () => {
    for (const text of [claude, cursor]) {
      expect(text).not.toMatch(PERMISSION_GRANT);
    }
  });

  it.each([
    ['the CLI probe refusal', '`mailoo test` is a CLI connection probe, not this runner'],
    ['the runner source', 'package.json` (runner — never infer it)'],
    ['no browser automation', 'No browser automation'],
  ])('binds the Mailoo runners: %s', (_name, phrase) => {
    for (const text of [claude, cursor]) {
      expect(text).toContain(phrase);
    }
  });

  it('names the runner of each lane in the testing doctrine', () => {
    const runners = doctrineRunners();
    expect(runners.map(([lane]) => lane)).toEqual(['Unit', 'Integration']);
    for (const text of [claude, cursor]) {
      for (const [lane, command] of runners) {
        expect(text).toContain(`${lane}: \`${command}\``);
      }
    }
  });
}
