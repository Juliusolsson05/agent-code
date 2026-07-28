// One word-counting rule, shared by main (which writes the lifetime totals) and
// the renderer (which may display per-entry counts).
//
// WHY this is shared rather than duplicated: the count is persisted at write
// time and never recomputed (see historyStore.ts), so main and renderer
// disagreeing would surface as a stats panel whose per-row numbers do not add
// up to its own total — a bug with no error and no stack trace.
//
// WHY the rule is deliberately naive: this counts whitespace-separated tokens.
// It is wrong for CJK (no spaces) and slightly generous with hyphenates. That
// is acceptable because the number's job is to answer "roughly how much have I
// dictated, and am I getting faster" — not to be a billing unit. A smarter
// segmenter (Intl.Segmenter) would be a behavior change to a persisted metric,
// so if it ever lands it needs a migration story, not a silent swap.
export function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}
