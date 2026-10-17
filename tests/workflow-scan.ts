// An expression inside run: is pasted into the script before bash parses it,
// so a crafted value runs as code. An env: value reaches bash as data. A pushed
// branch or tag name can hold shell syntax just like a dispatch input.
// The name can sit anywhere before the closing }}, even after a lone } such as format's {0},
// and can be written with an index: github['head_ref'], inputs['version'].
const untrusted =
  /\$\{\{(?:[^}]|\}(?!\}))*\b(?:inputs\s*[.[]|github\s*(?:\.|\[\s*['"])(?:event|head_ref|base_ref|ref(?:_name)?)\b)/;
// A concurrency group is a name the runner compares, never a script.
const allowed = /^\s*(?:if|group|[A-Z][A-Z0-9_]*):\s/;

/** Line ranges of each run: or script: key with its deeper lines: the whole code the runner hands over. */
function scriptRanges(lines: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (let start = 0; start < lines.length; start += 1) {
    const key = lines[start].match(/^(\s*(?:- )?)(?:run|script):/);
    if (key) {
      let end = start + 1;
      while (
        end < lines.length &&
        (!lines[end].trim() || lines[end].search(/\S/) > key[1].length)
      ) {
        end += 1;
      }
      ranges.push([start, end]);
    }
  }
  return ranges;
}

/**
 * The workflow text that pastes an untrusted expression into code. A run: or script: block is
 * matched whole: an expression can span lines, and a code line can look like an env key.
 */
export function shellPastes(yaml: string): string[] {
  const lines = yaml.split('\n');
  const scripts = scriptRanges(lines);
  const inScript = (index: number) => scripts.some(([start, end]) => index >= start && index < end);
  return [
    ...scripts
      .map(([start, end]) => lines.slice(start, end).join('\n'))
      .filter((script) => untrusted.test(script)),
    ...lines.filter(
      (line, index) => !inScript(index) && untrusted.test(line) && !allowed.test(line),
    ),
  ].map((text) => text.trim());
}
