/**
 * Marks text that arrived from outside this process (mail headers and bodies)
 * so a model can tell it apart from instructions we wrote.
 * Markers that already appear in the text are rewritten so they cannot close the block early.
 */

export const UNTRUSTED_BEGIN = '<<<UNTRUSTED_EXTERNAL_CONTENT>>>';
export const UNTRUSTED_END = '<<<END_UNTRUSTED_EXTERNAL_CONTENT>>>';

const QUOTED_BEGIN = '[[[UNTRUSTED_EXTERNAL_CONTENT]]]';
const QUOTED_END = '[[[END_UNTRUSTED_EXTERNAL_CONTENT]]]';

export function delimitUntrusted(value: string): string {
  const safe = value
    .replaceAll(UNTRUSTED_END, QUOTED_END)
    .replaceAll(UNTRUSTED_BEGIN, QUOTED_BEGIN);
  return `${UNTRUSTED_BEGIN}\n${safe}\n${UNTRUSTED_END}`;
}
