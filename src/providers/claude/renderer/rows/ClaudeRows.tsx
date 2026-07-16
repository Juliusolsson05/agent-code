// BARREL ONLY — the real Claude components live in
// providers/claude/renderer/components/<component>/ (dir-per-component
// convention, PR #555: every distinguished provider component owns a
// directory, even single-file ones — see components/edit/index.tsx for the
// full rationale).
//
// WHY this file survives as a re-export shim instead of being deleted: the
// feed's live painter (features/feed/ui/semantic/BlockRow.tsx) predates the
// capability registry's operation dispatch and imports Claude rows through
// EXACTLY this specifier — an edge that importBoundaries.test.ts grandfathers
// by exact string match. Keeping the specifier stable means the restructure
// adds ZERO new feed→provider edges and the eviction plan (route BlockRow
// through `renderOperation`) is unchanged. Provider-internal code must NOT
// import from here — reach the component directories directly; when the
// BlockRow migration lands, this file and its GRANDFATHERED entry are deleted
// together.

export { ClaudeLiveBashRow } from '@providers/claude/renderer/components/bash'
export { EditRow } from '@providers/claude/renderer/components/edit'
export { MultiEditRow } from '@providers/claude/renderer/components/multi-edit'
export { WriteRow } from '@providers/claude/renderer/components/write'
