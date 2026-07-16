// Command-formatter contract (PR #555 Phase 6; structure per product-owner
// direction 2026-07-16: one FILE per command family registered in index.ts —
// never a root if-statement dump).
//
// Rules (plan + #524's proven analyzeCommandOutput lessons):
//   - PURE: text in, enrichment or DECLINE (null) out. No side effects, no
//     provider wire types — formatters see plain text the caller already
//     stripped of ANSI and bounded.
//   - CONSERVATIVE: ambiguity declines. Multiple conflicting summaries must
//     never be summed or guessed (#524 watch-mode double-count lesson).
//   - ENRICH, NEVER REPLACE: the conclusion renders ABOVE the raw output;
//     the bounded raw evidence always stays.
//   - TERMINAL ONLY: callers invoke formatters only at terminal status —
//     parsing an incomplete stream mints false summaries.
//
// Future extension point (deliberate): a formatter may later add an
// optional `Component` for rich per-family bodies (git status tables etc.).
// The registry shape already supports that growth without a rewrite.

export type FormatterInput = {
  /** The command line (plain text, bounded). Lets a formatter scope itself
   *  (git.ts cares about `git …`) without parsing provider wire data. */
  command: string
  /** ANSI-stripped, cap-bounded output text. */
  plainOutput: string
  /** True when the output was capped before analysis — completeness-
   *  dependent formatters (whole-JSON) must decline. */
  wasCapped: boolean
  exitCode: number | null
}

export type CommandFormatter = {
  /** Stable id — appears in receipts/debug, never in user copy. */
  id: string
  /** One short trusted line, or null to decline. */
  conclude: (input: FormatterInput) => string | null
}
