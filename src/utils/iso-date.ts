/**
 * imapflow yields the raw header text instead of a Date when the Date header does not parse,
 * and `toISOString()` throws on the invalid Date that text makes. A message that cannot be
 * dated is dated when it was seen, so one bad header does not fail a whole tool call.
 */
export default function toIsoDate(value: unknown): string {
  let date: Date | undefined;
  if (value instanceof Date) date = value;
  else if (typeof value === 'string') date = new Date(value);
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : new Date().toISOString();
}
