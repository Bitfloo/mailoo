/**
 * Reads back what a generated AppleScript shows or sets, so a test asserts the value
 * the user sees instead of the escaped source text.
 */

const LITERAL_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t' };

function decodeLiteral(body: string): string {
  return body.replace(/\\(.)/g, (_match, ch: string) => LITERAL_ESCAPES[ch] ?? ch);
}

/** A string literal, `return`, `dialogText`, or `(name as text)`, then `&` or the end. */
const DIALOG_TOKEN =
  /\s*(?:"((?:[^"\\]|\\.)*)"|(return)|(dialogText)|\((\w+) as text\))\s*(?:&|$)/y;

function evaluateDialogExpression(expr: string, previous: string[]): string[] {
  const lines = [''];
  DIALOG_TOKEN.lastIndex = 0;
  while (DIALOG_TOKEN.lastIndex < expr.length) {
    const match = DIALOG_TOKEN.exec(expr);
    if (!match) throw new Error(`unparsed dialog expression: ${expr}`);
    const [, literal, ret, self, coerced] = match;
    if (literal !== undefined) lines[lines.length - 1] += decodeLiteral(literal);
    else if (ret !== undefined) lines.push('');
    else if (self !== undefined) {
      const [first = '', ...rest] = previous;
      lines[lines.length - 1] += first;
      lines.push(...rest);
    } else lines[lines.length - 1] += `<${coerced ?? ''}>`;
  }
  return lines;
}

/**
 * The confirm-dialog text built by a script's `set dialogText to …` lines, one item per
 * dialog line. A coercion such as `(eventStart as text)` reads as `<eventStart>`.
 */
export function dialogLinesOf(script: string): string[] {
  let lines: string[] = [];
  script.split('\n').forEach((line) => {
    const match = /^\s*set dialogText to (.*)$/.exec(line);
    if (match) lines = evaluateDialogExpression(match[1] ?? '', lines);
  });
  return lines;
}

/**
 * Runs a script's `set <name> to current date` and `set <part> of <name> to N` lines
 * against `now`. JavaScript dates overflow the way AppleScript dates do: day 31 of a
 * 30-day month becomes the 1st of the next month.
 */
export function dateSetBy(script: string, name: string, now: Date): Date {
  let date: Date | undefined;
  const part = new RegExp(`^set (year|month|day|hours|minutes|seconds) of ${name} to (\\d+)$`);
  script.split('\n').forEach((raw) => {
    const line = raw.trim();
    if (line === `set ${name} to current date`) {
      date = new Date(now);
      return;
    }
    const match = part.exec(line);
    if (!match || !date) return;
    const value = Number(match[2]);
    if (match[1] === 'year') date.setFullYear(value);
    else if (match[1] === 'month') date.setMonth(value - 1);
    else if (match[1] === 'day') date.setDate(value);
    else if (match[1] === 'hours') date.setHours(value);
    else if (match[1] === 'minutes') date.setMinutes(value);
    else date.setSeconds(value);
  });
  if (!date) throw new Error(`${name} is never set to current date`);
  return date;
}
