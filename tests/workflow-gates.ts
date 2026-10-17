/** A job's if: expression with folded lines joined and any ${{ }} wrapper removed. */
export function jobGate(job: string): string {
  const gate = job.match(/^ {4}if:(.*(?:\n {6,}\S.*)*)/m)?.[1];
  if (gate === undefined) {
    throw new Error('job has no if:');
  }
  return gate
    .replace(/^\s*[>|][-+]?/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\$\{\{(.*)\}\}$/, '$1')
    .trim();
}

/**
 * Whether a job runs, given its gate, the result of each job it needs, and any other context value
 * the caller passes, such as github.event_name. Only always(), needs.<job>.result, those values,
 * == and != against a quoted string, !, &&, || and parentheses are read. Anything else throws, so
 * a gate on a context the caller did not pass cannot pass unread.
 */
export function runsJob(
  gate: string,
  needs: Record<string, string>,
  context: Record<string, string | boolean> = {},
): boolean {
  const tokens: string[] = gate.match(/always\(\)|[\w.-]+|==|!=|&&|\|\||[!()]|'[^']*'|\S+/g) ?? [];
  let at = 0;
  const fail = (): never => {
    throw new Error(`unsupported gate at token ${at}: ${gate}`);
  };
  const next = (): string => {
    const token = tokens[at];
    at += 1;
    return token ?? fail();
  };
  const operand = (): boolean => {
    const token = next();
    if (token === '(') {
      const value = either();
      return next() === ')' ? value : fail();
    }
    if (token === '!') {
      return !operand();
    }
    if (token === 'always()') {
      return true;
    }
    const value = read(token);
    if (tokens[at] !== '==' && tokens[at] !== '!=') {
      return Boolean(value);
    }
    const equal = next() === '==';
    const expected = /^'([^']*)'$/.exec(next())?.[1] ?? fail();
    return (value === expected) === equal;
  };
  const read = (name: string): string | boolean => {
    const job = /^needs\.([\w-]+)\.result$/.exec(name)?.[1];
    if (job === undefined) {
      return Object.hasOwn(context, name) ? context[name] : fail();
    }
    return Object.hasOwn(needs, job) ? needs[job] : fail();
  };
  const both = (): boolean => {
    let value = operand();
    while (tokens[at] === '&&') {
      at += 1;
      value = operand() && value;
    }
    return value;
  };
  const either = (): boolean => {
    let value = both();
    while (tokens[at] === '||') {
      at += 1;
      value = both() || value;
    }
    return value;
  };
  const value = either();
  if (at < tokens.length) {
    fail();
  }
  // A gate with no status function gets the runner's implicit success(): every needed job succeeded.
  return (
    value &&
    (tokens.includes('always()') || Object.values(needs).every((result) => result === 'success'))
  );
}
