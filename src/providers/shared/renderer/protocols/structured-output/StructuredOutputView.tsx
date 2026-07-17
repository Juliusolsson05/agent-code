import { memo, useContext, useState } from 'react'

import { CodeRenderContext } from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'
import { PagedTextViewer } from '@renderer/lib/text/PagedTextViewer'
import { formatToolFilePath } from '@shared/paths/displayPath'

import {
  parseStructuredJsonSource,
  type StructuredJsonRecord,
  type StructuredOutputModel,
} from './model'

const PREVIEW_MAX_CHARS = 16 * 1024

function ExactTextDetails({
  summary,
  source,
  isError,
}: {
  summary: string
  source: string
  isError: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="text-[11px] text-muted"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none">{summary}</summary>
      {/* WHY native <details> alone is insufficient: React still mounts its
          children while the browser hides them. An explicit state gate keeps
          the paging scan and text subtree out of memory until user intent. */}
      {open ? (
        <div className="mt-1 rounded border border-border bg-surface px-2 py-1.5">
          <PagedTextViewer source={source} isError={isError} />
        </div>
      ) : null}
    </details>
  )
}

function recordLabel(record: StructuredJsonRecord, workspaceRoot: string | null): string {
  if (record.path && record.lineNumber !== null) {
    return `${formatToolFilePath(record.path, workspaceRoot)}:${record.lineNumber}`
  }
  if (record.prefix) return record.prefix
  return 'JSON record'
}

function StructuredRecord({
  record,
  workspaceRoot,
}: {
  record: StructuredJsonRecord
  workspaceRoot: string | null
}) {
  const [open, setOpen] = useState(false)
  const label = recordLabel(record, workspaceRoot)
  return (
    <details
      className="min-w-0 rounded border border-border/70 bg-surface/40 px-2 py-1"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary
        className={`cursor-pointer select-none text-[12px] ${record.isError ? 'text-danger' : 'text-ink-dim'}`}
        title={record.prefix || undefined}
      >
        <span className="font-code break-all">{label}</span>
        <span className="ml-2 text-[11px] text-muted">{record.summary}</span>
      </summary>
      {open ? (
        <div className="mt-2 space-y-2">
          {(() => {
            // WHY parse only after explicit expansion: validating the bounded
            // source during recognition proves the shape, but retaining every
            // parsed tree would double the memory of a result containing many
            // huge records. Reparse one admitted record at a time, project it
            // before syntax highlighting, and release it again when collapsed.
            const value = parseStructuredJsonSource(record.jsonSource)
            const preview = value === null
              ? null
              : boundedJsonPreview(value, PREVIEW_MAX_CHARS)
            return preview === null ? (
              <span className="text-[11px] text-danger">
                This record changed or exceeded the structured preview budget.
              </span>
            ) : (
              <CodeBlock code={preview} language="json" />
            )
          })()}
          <ExactTextDetails
            summary="View exact record source"
            source={record.jsonSource}
            isError={record.isError}
          />
        </div>
      ) : null}
    </details>
  )
}

export const StructuredOutputView = memo(function StructuredOutputView({
  model,
  source,
  isError = false,
}: {
  model: StructuredOutputModel
  source: string
  isError?: boolean
}) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const totalRecords = model.records.length + model.omittedRecordCount
  return (
    <MarkerRow marker="⎿" tone="muted">
      <div className="min-w-0 w-full space-y-2">
        <div className={`text-[12px] ${isError ? 'text-danger' : 'text-ink-dim'}`}>
          {totalRecords.toLocaleString()} structured{' '}
          {totalRecords === 1 ? 'record' : 'records'}
          {model.contextLines.length > 0
            ? ` · ${model.contextLines.length.toLocaleString()} context ${model.contextLines.length === 1 ? 'line' : 'lines'}`
            : ''}
        </div>

        {model.contextLines.length > 0 ? (
          <div className="rounded border border-border/70 bg-surface/40 px-2 py-1.5">
            {model.contextLines.map((line, index) => (
              <div key={`${index}:${line}`} className="font-code text-[11px] leading-[1.5] text-muted break-words">
                {line}
              </div>
            ))}
            {model.contextWasTruncated ? (
              <div className="mt-1 text-[11px] text-muted">Additional context lines are in the exact output.</div>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1">
          {model.records.map(record => (
            <StructuredRecord
              key={record.key}
              record={record}
              workspaceRoot={workspaceRoot}
            />
          ))}
        </div>

        {model.omittedRecordCount > 0 || model.scanWasTruncated ? (
          <div className="text-[11px] text-muted" role="status">
            Structured preview is bounded; additional records remain in the exact output.
          </div>
        ) : null}

        <ExactTextDetails
          summary="View exact paged output"
          source={source}
          isError={isError}
        />
      </div>
    </MarkerRow>
  )
})
