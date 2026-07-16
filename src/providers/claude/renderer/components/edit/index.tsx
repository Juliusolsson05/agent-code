// Claude `Edit` component (PR #555 — dir-per-component convention).
//
// WHY a whole directory for ~10 lines: product-owner structure rule
// (2026-07-16) — every DISTINGUISHED provider component lives in its own
// directory, even when it is currently one file. The directory is the unit
// of ownership: fixtures, sub-parts, and tests for THIS component land here
// instead of accreting into a shared grab-bag file (ClaudeRows.tsx grew to
// 300+ lines exactly that way), and the tree itself documents which
// operations each provider renders (`ls components/` = the coverage list).
//
// CUT OVER to the code-edit protocol (Phase 5): adapter → shared
// CodeEditView. Committed dispatch AND BlockRow's live streaming path both
// land here, so partial synthetic blocks stream through the same card.
// The adapter owns the oversize gate (bounded -/+ fallback replaces the
// old OversizedEditSlab — same protection, one home).

import { memo, useMemo } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'
import { fromClaudeEditBlock } from '@providers/claude/renderer/adapters/codeEdit'
import { CodeEditView } from '@providers/shared/renderer/protocols/code-edit/CodeEditView'

export const EditRow = memo(function EditRow({ block }: { block: ToolUseBlock }) {
  const model = useMemo(() => fromClaudeEditBlock(block), [block])
  if (!model) return null
  return <CodeEditView model={model} />
})
