import { keyLines } from './workflow-yaml.js';

// An expression inside run: is pasted into the script before bash parses it,
// so a crafted value runs as code. An env: value reaches bash as data. A pushed
// branch or tag name can hold shell syntax just like a dispatch input.
// The name can sit anywhere before the closing }}, even after a lone } such as format's {0},
// and can be written with an index: github['head_ref'], inputs['version']. toJSON(github) pastes
// every field at once. Context and property names are case-insensitive, and the expression lexer
// skips whitespace around the dot.
const untrusted =
  /\$\{\{(?:[^}]|\}(?!\}))*\b(?:inputs\s*[.[)]|github\s*\)|github\s*(?:\.\s*|\[\s*['"])(?:event|head_ref|base_ref|ref(?:_name)?)\b)/i;
// if: is an expression and a concurrency group a name the runner compares, never a script.
const allowed = /^\s*(?:if|group):\s/;

/** Line ranges of each key that `key` matches, with its deeper lines. */
function keyRanges(lines: string[], key: RegExp): [number, number][] {
  const ranges: [number, number][] = [];
  for (let start = 0; start < lines.length; start += 1) {
    const prefix = lines[start].match(key);
    if (prefix) {
      let end = start + 1;
      while (
        end < lines.length &&
        (!lines[end].trim() || lines[end].search(/\S/) > prefix[1].length)
      ) {
        end += 1;
      }
      ranges.push([start, end]);
    }
  }
  return ranges;
}

const within = (ranges: [number, number][]) => (index: number) =>
  ranges.some(([start, end]) => index >= start && index < end);

/**
 * Each key of an env: block mapping with the lines of its value. A line under env: that is no
 * part of a key, or an env: written any other way, stays a line the scan checks.
 */
function envEntries(lines: string[]): { name: string; range: [number, number] }[] {
  const entry = /^(\s*)["']?([\w-]+)["']?[ \t]*:/;
  return keyRanges(lines, /^(\s*(?:- )?)env:[ \t]*(?:#.*)?$/).flatMap(([start, end]) =>
    keyRanges(lines.slice(start + 1, end), entry).map(([from, to]) => ({
      name: lines[start + 1 + from].match(entry)?.[2] ?? '',
      range: [start + 1 + from, start + 1 + to] as [number, number],
    })),
  );
}

/**
 * Each uses: line that does not pin a commit SHA with the version tag in a comment. A uses: in a
 * flow mapping or under a quoted key is listed too, since the pin form below cannot match it.
 */
export function unpinnedUses(yaml: string): string[] {
  const pin = /^\s*(?:-\s*)?uses:\s+\S+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/;
  return keyLines(yaml, 'uses')
    .filter((line) => !pin.test(line))
    .map((line) => line.trim());
}

/**
 * The workflow text that pastes an untrusted expression into code. A run: or script: block is
 * matched whole: an expression can span lines, and a code line can look like an env key.
 */
export function shellPastes(yaml: string): string[] {
  const lines = yaml.split('\n');
  const scripts = keyRanges(lines, /^(\s*(?:- )?)(?:run|script):/);
  const inScript = within(scripts);
  const entries = envEntries(lines);
  const inEnv = within(entries.map(({ range }) => range));
  // An env value is data to bash, but ${{ env.NAME }} pastes that same value into the code.
  // The never-matching (?!) keeps an empty list from matching every name.
  const names = entries
    .filter(({ range: [start, end] }) => untrusted.test(lines.slice(start, end).join('\n')))
    .map(({ name }) => name)
    .concat('(?!)')
    .join('|');
  const viaEnv = new RegExp(
    String.raw`\$\{\{(?:[^}]|\}(?!\}))*\benv\s*(?:\.\s*(?:${names})\b|\[\s*['"](?:${names})['"])`,
    'i',
  );
  return [
    ...scripts
      .map(([start, end]) => lines.slice(start, end).join('\n'))
      .filter((script) => untrusted.test(script) || viaEnv.test(script)),
    ...lines.filter(
      (line, index) =>
        !inScript(index) &&
        !allowed.test(line) &&
        ((untrusted.test(line) && !inEnv(index)) || viaEnv.test(line)),
    ),
  ].map((text) => text.trim());
}
