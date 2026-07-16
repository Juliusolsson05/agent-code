import { memo, useContext } from 'react'

import { formatToolFilePath } from '@shared/paths/displayPath'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { DiffSlab } from '@providers/shared/renderer/rows/DiffSlab'
import type { CodeEditRenderModel } from '@providers/shared/renderer/protocols/code-edit/model'

// CodeEditView — the shared leaf view for the code-edit protocol (renderer
// rewrite, PR #555). Accepts ONLY CodeEditRenderModel; it cannot name a
// provider and never branches on one (import-boundary rule 7 — the exact
// coupling that sank PR #524's fileEdit.tsx, which imported BOTH providers'
// extractors). Providers wanting different chrome wrap this view; sharing
// line rendering never means sharing the operation component.
//
// Composes the EXISTING primitives (MarkerRow, DiffSlab, displayPath) —
// per the plan, the common base is composition, not a card class tree.
// DiffSlab already owns bounded windowing and stable gutter identity, which
// is what keeps a streaming tail updating in place instead of remounting.

export const CodeEditView = memo(function CodeEditView({ model }: { model: CodeEditRenderModel }) {
  const codeContext = useContext(CodeRenderContext)
  const totalAdd = model.files.reduce((n, f) => n + f.additions, 0)
  const totalDel = model.files.reduce((n, f) => n + f.deletions, 0)
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2 text-[13px] leading-[1.65] min-w-0">
          <span className="text-accent font-semibold flex-shrink-0">{model.label}</span>
          {model.files.length === 1 ? (
            <span
              className="text-ink-dim truncate min-w-0"
              title={model.files[0].path || undefined}
            >
              {model.files[0].verb}{' '}
              {model.files[0].path
                ? formatToolFilePath(model.files[0].path, codeContext.workspaceRoot)
                : '…'}
            </span>
          ) : (
            <span className="text-ink-dim">{model.files.length} files</span>
          )}
          <span className="text-muted text-[11px] tabular-nums flex-shrink-0">
            {totalAdd > 0 || totalDel > 0 ? `+${totalAdd} −${totalDel}` : null}
            {model.status === 'streaming' ? ' · streaming…' : null}
            {model.status === 'running' ? ' · running' : null}
            {model.status === 'failure' ? ' · FAILED' : null}
          </span>
        </div>
        {/* Failure is always visible without expansion (plan hard rule). */}
        {model.errorSummary ? (
          <div className="text-red-400 text-[12px]" role="status">
            {model.errorSummary}
          </div>
        ) : null}
        {model.files.map((file, i) => (
          <div key={file.path || i} className="flex flex-col gap-0.5">
            {model.files.length > 1 ? (
              <div
                className="text-ink-dim text-[12px] truncate"
                title={file.path || undefined}
              >
                {file.verb}{' '}
                {file.path
                  ? formatToolFilePath(file.path, codeContext.workspaceRoot)
                  : '…'}{' '}
                <span className="text-muted tabular-nums">
                  +{file.additions} −{file.deletions}
                </span>
              </div>
            ) : null}
            {file.lines.length > 0 ? <DiffSlab lines={[...file.lines]} /> : null}
          </div>
        ))}
      </div>
    </MarkerRow>
  )
})
