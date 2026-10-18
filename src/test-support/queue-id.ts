/** A schedule id (a v4 UUID, as the queue requires) that sorts by its index. */
export default function queueId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
