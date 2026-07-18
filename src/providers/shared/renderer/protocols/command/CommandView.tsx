import hljs from 'highlight.js'
import { memo, useContext, useMemo } from 'react'

import { formatToolFilePath } from '@shared/paths/displayPath'
import { CodeRenderContext } from '@renderer/features/feed/context'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { OutputWell } from '@renderer/lib/text/OutputWell'
import type { CommandRenderModel } from '@providers/shared/renderer/protocols/command/model'

// CommandView — shared leaf view for the command protocol (PR #555 Phase
// 6). Accepts ONLY CommandRenderModel; cannot name a provider, never
// branches on one. Composes the ported #524 primitives: OutputWell owns
// head+tail bounding and ANSI painting, so a colored test run renders like
// the terminal would have shown it, bounded.

const STATUS_LABEL: Record<CommandRenderModel['status'], string> = {
  streaming: 'streaming…',
  running: 'running',
  success: '',
  failure: 'FAILED',
  timeout: 'TIMED OUT',
  // Deliberately quiet but visible: the command finished and its output is
  // real, but the transport never proved exit 0, so the row must not read as
  // an implicit success (which an empty label would).
  unknown: 'exit unknown',
}

export const CommandView = memo(function CommandView({ model }: { model: CommandRenderModel }) {
  const status = STATUS_LABEL[model.status]
  const { workspaceRoot } = useContext(CodeRenderContext)
  // Prettified command headline (product-owner request): one bounded hljs
  // bash pass, memoized — the command string is already display-capped by
  // the adapter, so this is O(headline), never O(payload).
  const commandHtml = useMemo(
    () =>
      model.command
        ? hljs.highlight(model.command, { language: 'bash', ignoreIllegals: true }).value
        : '',
    [model.command],
  )
  return (
    <div className="flex flex-col gap-0.5">
      <MarkerRow marker="⏺">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-baseline gap-2 text-[13px] leading-[1.65] min-w-0">
            <span className="text-accent font-semibold flex-shrink-0">{model.label}</span>
            {commandHtml ? (
              <span
                className="hljs font-code text-[12px] text-ink-dim min-w-0 bg-transparent whitespace-pre-wrap break-words line-clamp-2"
                title={model.command}
                dangerouslySetInnerHTML={{ __html: commandHtml }}
              />
            ) : (
              <span className="font-code text-[12px] text-ink-dim truncate min-w-0">…</span>
            )}
            <span
              className={`text-[11px] uppercase tracking-wider flex-shrink-0 ${
                model.status === 'failure' || model.status === 'timeout' ? 'text-danger' : 'text-muted'
              }`}
            >
              {status}
              {model.exitCode !== null && model.exitCode !== 0 ? ` · exit ${model.exitCode}` : ''}
            </span>
          </div>
          {model.cwd ? (
            <div className="text-muted text-[11px] font-code truncate" title={model.cwd}>
              in {formatToolFilePath(model.cwd, workspaceRoot)}
            </div>
          ) : null}
          {/* Failure summary always visible without expansion (plan rule). */}
          {model.errorSummary ? (
            <div className="text-danger text-[12px]" role="status">
              {model.errorSummary}
            </div>
          ) : null}
          {/* Formatter conclusion ENRICHES the evidence — it sits above the
              bounded raw output and never replaces it (plan formatter rule). */}
          {model.conclusion ? (
            <div className="text-ink-dim text-[12px]">{model.conclusion}</div>
          ) : null}
        </div>
      </MarkerRow>
      {model.output !== undefined ? (
        model.output === '' ? (
          <MarkerRow marker="⎿" tone="muted">
            <span className="text-muted text-[12px] italic">(no output)</span>
          </MarkerRow>
        ) : (
          <OutputWell text={model.output} isError={model.outputIsError === true} />
        )
      ) : null}
    </div>
  )
})
