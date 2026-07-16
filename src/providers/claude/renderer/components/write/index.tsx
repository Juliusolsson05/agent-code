// Claude `Write` component (PR #555 — dir-per-component convention; see
// components/edit/index.tsx for why single-file components still get a
// directory).
//
// CUT OVER to the code-edit protocol (Phase 5 pattern proof): Claude
// adapter → shared CodeEditView. Write renders as pure additions (honest
// no-before-state semantics) instead of a plain code slab, and gains the
// shared header/±counts/status grammar. Both the committed dispatch AND
// BlockRow's live path converge here, so streaming upgrades for free.

import { memo, useMemo } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'
import { fromClaudeEditBlock } from '@providers/claude/renderer/adapters/codeEdit'
import { CodeEditView } from '@providers/shared/renderer/protocols/code-edit/CodeEditView'

export const WriteRow = memo(function WriteRow({ block }: { block: ToolUseBlock }) {
  const model = useMemo(() => fromClaudeEditBlock(block), [block])
  if (!model) return null // name !== Write — dispatch never sends that
  return <CodeEditView model={model} />
})
