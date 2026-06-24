import type { GitNumstatLine } from '@shared/types/gitStatus.js'

// `git diff --numstat` parser.
//
// WHY extracted from main/ipc/git.ts: it is a pure string→rows function with
// one tricky invariant worth a unit test and one home — binary files emit '-'
// for both counts, and we coerce those to 0 so the GitBar UI never has to
// special-case the marker. Tabs separate the three fields; a malformed line
// (no filename) is skipped rather than throwing.
//
// Node-free / DOM-free pure function — lives under src/shared/git so main can
// import it. The GitBar types live in @shared/types/gitStatus (renderer-visible).
export function parseNumstat(text: string): GitNumstatLine[] {
  const out: GitNumstatLine[] = []
  for (const line of text.trim().split('\n')) {
    if (!line) continue
    const [a, d, f] = line.split('\t')
    if (!f) continue
    out.push({
      file: f,
      additions: a === '-' ? 0 : parseInt(a, 10) || 0,
      deletions: d === '-' ? 0 : parseInt(d, 10) || 0,
    })
  }
  return out
}
