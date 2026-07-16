// BARREL ONLY — the real Codex components live in
// providers/codex/renderer/components/<component>/ (dir-per-component
// convention, PR #555 — see providers/claude/renderer/components/edit/
// index.tsx for the full rationale).
//
// WHY this file survives as a re-export shim instead of being deleted: the
// feed's live painter (features/feed/ui/semantic/BlockRow.tsx) imports Codex
// rows through EXACTLY this specifier — an edge importBoundaries.test.ts
// grandfathers by exact string match. Keeping the specifier stable means the
// restructure adds ZERO new feed→provider edges. Provider-internal code must
// NOT import from here — reach the component directories directly; when the
// BlockRow migration (route through `renderOperation`) lands, this file and
// its GRANDFATHERED entry are deleted together.
//
// Dead code note: the legacy monolith's unused PatchFileHeader (orphaned by
// the Phase 5 CodeEditView cutover) was dropped during this split rather
// than moved — it rendered per-file ApplyPatch headers the shared view now
// owns.

export { CodexApplyPatchRow } from '@providers/codex/renderer/components/apply-patch'
export { CodexExecCommandRow } from '@providers/codex/renderer/components/exec-command'
export { CodexToolResultRow } from '@providers/codex/renderer/components/tool-result'
export { CodexToolRow } from '@providers/codex/renderer/components/tool'
export { CodexWriteStdinRow } from '@providers/codex/renderer/components/write-stdin'
