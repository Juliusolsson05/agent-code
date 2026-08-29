import { memo, useContext } from 'react'

import { formatToolFilePath } from '@shared/paths/displayPath'
import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { DiffSlab } from '@providers/shared/renderer/rows/DiffSlab'
import type { CodeEditRenderModel } from '@providers/shared/renderer/protocols/code-edit/model'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'

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
  // The view is a second admission boundary. Provider adapters are expected
  // to cap their model, but a future adapter mistake must not regain the
  // ability to mount thousands of files in one paint.
  const files = model.files.slice(0, 24)
  const filesTruncated = model.filesTruncated === true || model.files.length > files.length
  const totalFiles = model.totalFiles ?? model.files.length
  const fileCountTruncated = model.fileCountTruncated === true
  const totalAdd = files.reduce((n, f) => n + f.additions, 0)
  const totalDel = files.reduce((n, f) => n + f.deletions, 0)
  const countsTruncated = fileCountTruncated || filesTruncated || files.some(file => file.countsTruncated)
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2 text-[13px] leading-[1.65] min-w-0">
          <span className="text-accent font-semibold flex-shrink-0">{model.label}</span>
          {!fileCountTruncated && totalFiles === 1 && files.length === 1 ? (
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
            <span className="text-ink-dim">
              {fileCountTruncated ? '≥' : ''}{totalFiles} {totalFiles === 1 ? 'file' : 'files'}
            </span>
          )}
          <span className="text-muted text-[11px] tabular-nums flex-shrink-0">
            {totalAdd > 0 || totalDel > 0
              ? `+${countsTruncated ? '≥' : ''}${totalAdd} −${countsTruncated ? '≥' : ''}${totalDel}`
              : null}
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
        {files.map((file, i) => (
          // WHY ordinal identity is the truthful key here: MultiEdit may
          // contain several operations against the same path, while a live
          // operation begins with an empty path and fills it on a later props
          // update. Path-based keys are therefore neither unique nor stable;
          // they trigger duplicate-key reconciliation and remount the exact
          // streaming tail DiffSlab is designed to preserve. Adapters append
          // operations in wire order and never reorder this bounded list, so
          // the ordinal is the model's stable operation identity.
          <div key={i} className="flex flex-col gap-0.5">
            {fileCountTruncated || totalFiles > 1 ? (
              <div
                className="text-ink-dim text-[12px] truncate"
                title={file.path || undefined}
              >
                {file.verb}{' '}
                {file.path
                  ? formatToolFilePath(file.path, codeContext.workspaceRoot)
                  : '…'}{' '}
                <span className="text-muted tabular-nums">
                  +{file.countsTruncated ? '≥' : ''}{file.additions}{' '}
                  −{file.countsTruncated ? '≥' : ''}{file.deletions}
                </span>
              </div>
            ) : null}
            {file.lines.length > 0 ? <DiffSlab lines={[...file.lines]} filePath={file.path || undefined} emptyLabel="(no inline diff)" /> : null}
            {file.previewTruncated && file.exactSections?.length ? (
              <details className="text-[11px] text-muted">
                <summary className="cursor-pointer select-none">
                  Rich preview is partial · view exact paged content
                </summary>
                <div className="mt-1 flex flex-col gap-2 rounded-slab border border-border bg-surface px-2 py-1.5">
                  {file.exactSections.map((section, sectionIndex) => (
                    // Labels are presentation vocabulary (for example two
                    // "Content" sections), not guaranteed identifiers.
                    <div key={sectionIndex} className="min-w-0">
                      <div className="mb-1 font-semibold text-ink-dim">{section.label}</div>
                      <PagedTextViewer source={section.text} />
                    </div>
                  ))}
                </div>
              </details>
            ) : file.previewTruncated ? (
              <div className="text-[11px] text-muted">Inline preview capped for renderer safety.</div>
            ) : null}
          </div>
        ))}
        {filesTruncated ? (
          <div className="text-[11px] text-muted">
            Showing {files.length} of {totalFiles} file operations.
          </div>
        ) : null}
        {fileCountTruncated ? (
          <div className="text-[11px] text-muted">
            File and change totals are lower bounds from a renderer-safe patch prefix.
          </div>
        ) : null}
      </div>
    </MarkerRow>
  )
})
