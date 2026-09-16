/**
 * Received-byte bookkeeping.
 *
 * Chunks may land out of order, from several lanes, a resumed transfer or a reordered relay,
 * so "how much do I have" is a set of ranges, not a single number. The contiguous prefix
 * of that set is what may be acknowledged as durable, and therefore what a resume starts
 * from.
 */

/** Merge [start, end) into a sorted, coalesced list of ranges. Mutates and returns it. */
export function addRange(ranges, start, end) {
  if (end <= start) return ranges;
  let i = 0;
  while (i < ranges.length && ranges[i][1] < start) i++;
  let s = start;
  let e = end;
  let j = i;
  while (j < ranges.length && ranges[j][0] <= e) {
    s = Math.min(s, ranges[j][0]);
    e = Math.max(e, ranges[j][1]);
    j++;
  }
  ranges.splice(i, j - i, [s, e]);
  return ranges;
}

/** Bytes held contiguously from zero: the only offset that is safe to resume from. */
export function contiguous(ranges) {
  return ranges.length && ranges[0][0] === 0 ? ranges[0][1] : 0;
}

/** Total bytes held, gaps excluded. */
export function covered(ranges) {
  let n = 0;
  for (const [s, e] of ranges) n += e - s;
  return n;
}

/** The gaps below `size`, which is exactly what a resume needs to request. */
export function missing(ranges, size) {
  const gaps = [];
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s > cursor) gaps.push([cursor, Math.min(s, size)]);
    cursor = Math.max(cursor, e);
    if (cursor >= size) break;
  }
  if (cursor < size) gaps.push([cursor, size]);
  return gaps;
}
