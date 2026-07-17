// Claude `Write` component (PR #555 — dir-per-component convention; see
// components/edit/index.tsx for why single-file components still get a
// directory).
//
// CUT OVER to the code-edit protocol (Phase 5 pattern proof): Claude
// adapter → shared CodeEditView. Write renders as pure additions (honest
// no-before-state semantics) instead of a plain code slab, and gains the
// shared header/±counts/status grammar. Both the committed dispatch AND
// BlockRow's live path converge here, so streaming upgrades for free.

import { memo } from 'react'

import type { CodeEditRenderModel } from '@providers/shared/renderer/protocols/code-edit/model'
import { CodeEditView } from '@providers/shared/renderer/protocols/code-edit/CodeEditView'

export const WriteRow = memo(function WriteRow({
  model,
}: {
  model: CodeEditRenderModel
}) {
  return <CodeEditView model={model} />
})
