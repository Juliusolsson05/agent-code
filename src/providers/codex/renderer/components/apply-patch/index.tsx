// Codex `apply_patch` component (dir-per-component convention, PR #555 —
// see providers/claude/renderer/components/edit/index.tsx for the rule).

import { memo } from 'react'

import type { CodeEditRenderModel } from '@providers/shared/renderer/protocols/code-edit/model'
import { CodeEditView } from '@providers/shared/renderer/protocols/code-edit/CodeEditView'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'

// Keep this synchronized with CodeEditView's defensive render cap. The shared
// leaf intentionally does not expose provider chrome policy, so the Codex
// wrapper must recognize when that leaf hid model operations and offer the
// provider's exact raw patch escape hatch.
const CODE_EDIT_VIEW_OPERATION_CAP = 24

export const CodexApplyPatchRow = memo(function CodexApplyPatchRow({
  model,
  rawPatch,
}: {
  model: CodeEditRenderModel
  rawPatch: string
}) {
  // CUT OVER to the code-edit protocol (PR #555 Phase 5): Codex adapter →
  // shared CodeEditView. The provider component WRAPS the shared view (the
  // plan's chrome rule) to keep the Codex-specific “rich preview is partial”
  // exact-paged-patch disclosure. Admission
  // happens before this component is created, so an invalid patch can fall
  // back visibly instead of becoming a specialized React element that later
  // returns null.
  // WHY disclosure is derived exclusively from the admitted model: asking the
  // raw patch whether it is “long” either misses many tiny operations (the
  // shared view hides operation 25 even when the source is only a few KiB) or
  // scans hidden source merely to decide whether to mount a collapsed control.
  // The adapter already paid to produce cardinality/truncation evidence. Use
  // that evidence here, then let PagedTextViewer inspect only the requested
  // page after the user opens the disclosure.
  const totalFiles = model.totalFiles ?? model.files.length
  const previewIncomplete =
    model.files.length > CODE_EDIT_VIEW_OPERATION_CAP ||
    model.filesTruncated === true ||
    model.fileCountTruncated === true ||
    totalFiles > model.files.length ||
    model.files.some(file => file.previewTruncated === true)

  return (
    <div className="flex flex-col gap-1">
      <CodeEditView model={model} />
      {previewIncomplete ? (
        <details className="text-[11px] text-muted">
          <summary className="cursor-pointer select-none">
            Rich preview is partial · view exact paged patch
          </summary>
          <div className="mt-1 rounded-slab border border-border bg-surface px-2 py-1.5">
            <PagedTextViewer source={rawPatch} />
          </div>
        </details>
      ) : null}
    </div>
  )
})
