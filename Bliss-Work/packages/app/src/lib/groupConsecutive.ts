/**
 * Buckets a already-sorted list into consecutive runs sharing the same label
 * — e.g. rows already ordered by time, grouped under the day they fall on.
 * Shared by meetingTime.ts's and mailView.ts's own `groupByDay`, which each
 * had this exact "same label as the last group → append, else start a new
 * one" loop, parameterized only by the item type and where its label comes
 * from.
 */
export function groupConsecutiveByLabel<T>(
  items: T[],
  labelOf: (item: T) => string,
): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = labelOf(item);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}
