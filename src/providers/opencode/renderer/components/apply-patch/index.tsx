import { memo } from 'react'

import type { CodeEditRenderModel } from '@providers/shared/renderer/protocols/code-edit/model'
import { CodeEditView } from '@providers/shared/renderer/protocols/code-edit/CodeEditView'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'

const CODE_EDIT_VIEW_OPERATION_CAP = 24

export const OpencodeApplyPatchRow = memo(function OpencodeApplyPatchRow({
  model,
  rawPatch,
}: {
  model: CodeEditRenderModel
  rawPatch: string
}) {
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
          <div className="mt-1 rounded border border-border bg-surface px-2 py-1.5">
            <PagedTextViewer source={rawPatch} />
          </div>
        </details>
      ) : null}
    </div>
  )
})
