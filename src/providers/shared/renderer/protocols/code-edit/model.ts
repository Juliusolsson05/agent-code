import type { DiffLine } from '@shared/parsers/lineDiff'

// CodeEditRenderModel — the first shared visual protocol (renderer rewrite,
// PR #555; plan §Phase 5). A NARROW LEAF CONTRACT: provider adapters map
// their own wire shapes into this model one-way; the shared CodeEditView
// consumes ONLY this. It carries visual truth (files, lines, counts,
// status) and deliberately has no provider field, no raw-payload escape
// hatch, and no parsing — the import-boundary rules make regressions on
// that a CI failure, not a review catch.
//
// STREAMING-FIRST is the load-bearing design rule (the trap this project
// exists to avoid): adapters must produce a paintable model from the FIRST
// closed tokens — path known → header paints; body still streaming → lines
// grow in place. `partial: true` marks such models; completion is a props
// update to the same row, never a different component. Nothing in this
// contract may require the full input to exist.

export type CodeEditVerb = 'Creating' | 'Editing' | 'Writing' | 'Deleting' | 'Moving'

export type CodeEditFile = {
  /** Raw path as the provider gave it; display-relativization is the
   *  view's job (workspaceRoot context), never the adapter's. Empty string
   *  while a streaming input has not yet closed its path token. */
  path: string
  verb: CodeEditVerb
  /** Precomputed diff lines — adapters diff, the view only paints. */
  lines: readonly DiffLine[]
  additions: number
  deletions: number
  /** True while this file's content is still streaming (tail updates in
   *  place; the view must keep gutter identity stable). */
  streaming: boolean
}

export type CodeEditStatus = 'streaming' | 'running' | 'success' | 'failure'

export type CodeEditRenderModel = {
  /** Provider-chosen operation label (e.g. 'Edit', 'MultiEdit', 'Write',
   *  'apply_patch') — vocabulary, not identity; the view never branches
   *  on it beyond printing. */
  label: string
  files: readonly CodeEditFile[]
  status: CodeEditStatus
  /** One bounded line, visible without expansion (plan: failure never
   *  hides behind a disclosure). */
  errorSummary?: string
  partial: boolean
}
