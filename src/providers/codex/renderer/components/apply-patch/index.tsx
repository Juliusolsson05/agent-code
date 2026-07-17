// Codex `apply_patch` component (dir-per-component convention, PR #555 —
// see providers/claude/renderer/components/edit/index.tsx for the rule).

import { memo } from 'react'

import type { CodeEditRenderModel } from '@providers/shared/renderer/protocols/code-edit/model'
import { CodeEditView } from '@providers/shared/renderer/protocols/code-edit/CodeEditView'
import { boundedTextPage } from '@renderer/lib/text/boundedText'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'

export const CodexApplyPatchRow = memo(function CodexApplyPatchRow({
  model,
  rawPatch,
}: {
  model: CodeEditRenderModel
  rawPatch: string
}) {
  // CUT OVER to the code-edit protocol (PR #555 Phase 5): Codex adapter →
  // shared CodeEditView. The provider component WRAPS the shared view (the
  // plan's chrome rule) to keep two codex-specific affordances: the
  // and the "rich preview is partial" exact-paged-patch disclosure. Admission
  // happens before this component is created, so an invalid patch can fall
  // back visibly instead of becoming a specialized React element that later
  // returns null.
  const previewIncomplete = boundedTextPage(rawPatch).hasNext

  return (
    <div className="flex flex-col gap-1">
      <CodeEditView model={model} />
      {previewIncomplete ? (
        <details className="text-[11px] text-muted">
          <summary className="cursor-pointer select-none">
            Rich preview is partial · view exact paged patch
          </summary>
          <div className="mt-1 rounded border border-border bg-surface px-2 py-1.5">
            <PagedTextViewer source={rawPatch} />
          </div>
        </details>
      ) : null}
    </div>
  )
})
