// An expression inside run: is pasted into the script before bash parses it,
// so a crafted value runs as code. An env: value reaches bash as data. A pushed
// branch or tag name can hold shell syntax just like a dispatch input.
// The name can sit anywhere before the closing }}, even after a lone } such as format's {0}.
const untrusted =
  /\$\{\{(?:[^}]|\}(?!\}))*\b(?:inputs\.|github\.event\.|github\.(?:head_ref|base_ref|ref(?:_name)?)\b)/;
// A concurrency group is a name the runner compares, never a script.
const allowed = /^\s*(?:if|group|[A-Z][A-Z0-9_]*):\s/;

/** Line ranges of each run: key with its deeper lines, the whole script the runner hands bash. */
function runRanges(lines: string[]): [number, number][] {
  return lines.flatMap((line, start): [number, number][] => {
    const key = line.match(/^(\s*(?:- )?)run:/);
    if (!key) {
      return [];
    }
    let end = start + 1;
    while (end < lines.length && (!lines[end].trim() || lines[end].search(/\S/) > key[1].length)) {
      end += 1;
    }
    return [[start, end]];
  });
}

/**
 * The workflow text that pastes an untrusted expression into code. A run: script is
 * matched whole: an expression can span lines, and a script line can look like an env key.
 */
export function shellPastes(yaml: string): string[] {
  const lines = yaml.split('\n');
  const runs = runRanges(lines);
  const inRun = (index: number) => runs.some(([start, end]) => index >= start && index < end);
  return [
    ...runs
      .map(([start, end]) => lines.slice(start, end).join('\n'))
      .filter((script) => untrusted.test(script)),
    ...lines.filter((line, index) => !inRun(index) && untrusted.test(line) && !allowed.test(line)),
  ].map((text) => text.trim());
}
