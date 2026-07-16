// Line-level diff used by Feed's Edit / MultiEdit rendering.
//
// This is a deliberately minimal implementation — no third-party diff lib,
// no character-level precision, no word-level highlighting. For the Edit
// tool's old_string / new_string pairs that's fine: CC's edits are
// typically short (under a few hundred lines each) and what the reader
// needs is "which lines went away, which lines came in, which lines
// stayed" — not a structural semantic diff.
//
// Lives under src/core/parsers/ so it's importable from the renderer,
// main, AND the testbench, same as streamingScreen.ts. Pure function, no
// Node, no DOM.
//
// Algorithm: standard Longest Common Subsequence (LCS) with an O(m×n)
// dynamic-programming table. For a 500-line file pair that's 250k cells
// of fills — instant on any modern CPU. If we ever find ourselves
// diffing truly huge files we can swap in Myers' algorithm, but until
// then simpler wins.
//
// Why LCS and not a naive line-by-line equality walk:
//   A naive walk would flag every line after the first insertion or
//   deletion as "changed" because the indices drift. LCS finds the
//   maximum common subsequence of lines and marks only the non-matching
//   ones, so a one-line change in the middle of a 100-line file shows
//   up as exactly two diff lines (- and +), not as 100.

export type DiffLine = {
  /** 'ctx' = unchanged line shown as context.
   *  '-'   = removed from old_string.
   *  '+'   = added in new_string. */
  kind: 'ctx' | '-' | '+'
  text: string
}

/**
 * Line-level LCS diff between two multi-line strings.
 *
 * Returns a flat sequence of DiffLine objects in display order. Removed
 * lines appear at their position in `oldText`; added lines appear at the
 * corresponding position in `newText`; context lines appear once,
 * representing the shared LCS.
 *
 * Empty inputs are handled — a diff of '' vs 'foo' yields one '+' line.
 *
 * The returned array is suitable for rendering with a per-line bg color
 * (green for +, red for -, plain for ctx). It does NOT preserve trailing
 * newlines — trailing empty lines are dropped so a file that ends with
 * '\n' doesn't produce a phantom final blank.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const m = a.length
  const n = b.length

  // Empty-side replacements need no alignment at all. More importantly, the
  // old `m * n` matrix guard evaluated to zero when either side was empty, then
  // still allocated `(m + 1) * (n + 1)` cells. A generated file compared with
  // an empty string could therefore bypass the safety policy by definition.
  if (m === 0) return b.map(text => ({ kind: '+' as const, text }))
  if (n === 0) return a.map(text => ({ kind: '-' as const, text }))

  // LCS is excellent for the normal short Edit payload, but its matrix grows
  // with the ACTUAL `(m+1)*(n+1)` allocation below. A provider can replace a
  // generated file with another generated file and turn an innocent render
  // into hundreds of millions of cells. Above this bound, keep an honest red/
  // green diff using common edges rather than risking the renderer process for
  // a more minimal middle alignment.
  if ((m + 1) * (n + 1) > 2_000_000) return linearDiffFromLines(a, b, true)

  // lcs[i][j] = length of the longest common subsequence of a[0..i) and
  // b[0..j). Row i=0 / col j=0 are the base case: empty prefix vs
  // anything is LCS 0. The table lives in a single Int32Array to avoid
  // Array<Array> allocation overhead for the common mid-sized case.
  const width = n + 1
  const lcs = new Int32Array((m + 1) * width)
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        lcs[i * width + j] = lcs[(i - 1) * width + (j - 1)] + 1
      } else {
        const up = lcs[(i - 1) * width + j]
        const left = lcs[i * width + (j - 1)]
        lcs[i * width + j] = up >= left ? up : left
      }
    }
  }

  // Walk the table backward from (m, n) to (0, 0), collecting diff lines
  // in reverse. At each step: if characters match, it's context; else
  // if the up-neighbor's LCS value is >= left's, the old line was
  // removed (we came from up, meaning we consumed a[i-1]); otherwise
  // the new line was added (we came from left, meaning we consumed
  // b[j-1]). The >= tiebreaker biases toward showing removals before
  // additions when a change sits at a boundary — matches `diff -u`.
  const out: DiffLine[] = []
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ kind: 'ctx', text: a[i - 1] })
      i--
      j--
    } else if (lcs[(i - 1) * width + j] >= lcs[i * width + (j - 1)]) {
      out.push({ kind: '-', text: a[i - 1] })
      i--
    } else {
      out.push({ kind: '+', text: b[j - 1] })
      j--
    }
  }
  // Flush whichever side still has lines left — these are pure
  // prefix removals (i>0) or prefix additions (j>0) that happened
  // before the first common line.
  while (i > 0) {
    out.push({ kind: '-', text: a[--i] })
  }
  while (j > 0) {
    out.push({ kind: '+', text: b[--j] })
  }

  out.reverse()
  return out
}

/**
 * Linear provisional diff for a still-growing Edit/MultiEdit payload.
 *
 * A partial `new_string` has no stable suffix, so running the O(m*n) LCS on
 * every token is both expensive and visually self-defeating. Shared prefix
 * lines are already proven context; the remaining old/new prefixes are honest
 * removals/additions. Once input finalizes, `diffLines` upgrades to the minimal
 * LCS result (or its bounded large-file fallback).
 */
export function streamingDiffLines(oldText: string, newText: string): DiffLine[] {
  return linearDiffFromLines(splitLines(oldText), splitLines(newText), false)
}

function linearDiffFromLines(
  oldLines: string[],
  newLines: string[],
  includeStableSuffix: boolean,
): DiffLine[] {
  const limit = Math.min(oldLines.length, newLines.length)
  let prefix = 0
  while (prefix < limit && oldLines[prefix] === newLines[prefix]) prefix += 1

  let oldEnd = oldLines.length
  let newEnd = newLines.length
  if (includeStableSuffix) {
    while (
      oldEnd > prefix &&
      newEnd > prefix &&
      oldLines[oldEnd - 1] === newLines[newEnd - 1]
    ) {
      oldEnd -= 1
      newEnd -= 1
    }
  }

  return [
    ...oldLines.slice(0, prefix).map(text => ({ kind: 'ctx' as const, text })),
    ...oldLines.slice(prefix, oldEnd).map(text => ({ kind: '-' as const, text })),
    ...newLines.slice(prefix, newEnd).map(text => ({ kind: '+' as const, text })),
    ...oldLines.slice(oldEnd).map(text => ({ kind: 'ctx' as const, text })),
  ]
}

/**
 * Split a string into lines without producing a phantom trailing empty
 * line for inputs that end with '\n'. We want diffLines('a\n', 'a\n')
 * to yield exactly one context line, not two (one ctx + one empty).
 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  // If the original ended with '\n', split produces a trailing '' we
  // don't want to diff against. Drop it.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
