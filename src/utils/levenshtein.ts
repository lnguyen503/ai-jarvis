/**
 * Standard Levenshtein edit distance (v1.14.3 R5).
 *
 * Used by the /organize restore smart-404 handler to find closest id matches
 * in .trash/ when the requested id is not found. No new npm dependencies —
 * hand-rolled per the v1.14.3 non-negotiables.
 *
 * Time: O(m × n), Space: O(min(m, n)) — two-row DP.
 */

/**
 * Compute the Levenshtein edit distance between two strings.
 * Returns the minimum number of single-character edits (insertions,
 * deletions, substitutions) required to change `a` into `b`.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Optimize: ensure `a` is the shorter string to minimize space.
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Two-row DP: prev[j] = distance for a[0..i-1], b[0..j-1]
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  const curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,          // deletion
        (curr[j - 1] ?? 0) + 1,      // insertion
        (prev[j - 1] ?? 0) + cost,    // substitution
      );
    }
    prev = curr.slice();
  }

  return prev[n] ?? n;
}
