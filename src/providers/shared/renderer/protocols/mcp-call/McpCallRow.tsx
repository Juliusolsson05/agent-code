import { useId, useState } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'

import type { McpCallModel } from './model'

const ARGUMENTS_MAX = 16 * 1024

/**
 * One MCP call, one line (model.ts says why and what it may absorb). The
 * line opens to the call's arguments and, when the line absorbed the result
 * row (an error, a refusal), the full result text — so collapsing the old
 * rows hides nothing.
 */
export function McpCallRow({ model, block }: { model: McpCallModel; block: ToolUseBlock }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  const verdict = VERDICT[model.outcome]
  const argumentsText = (() => {
    const json = JSON.stringify(block.input ?? {}, null, 2)
    return json.length > ARGUMENTS_MAX ? `${json.slice(0, ARGUMENTS_MAX)}\n… (truncated, ${json.length.toLocaleString()} characters)` : json
  })()
  return (
    <div className="flex gap-2 py-0.5" data-mcp-call={model.outcome}>
      <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-dim" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 items-baseline gap-2 text-left text-[12.5px]"
          title={`${model.server} · ${model.tool}`}
        >
          <span aria-hidden className="w-3 shrink-0 text-center font-code text-muted">◆</span>
          <span className="min-w-0 max-w-[45%] shrink-0 truncate font-code text-ink">{model.tool}</span>
          {/* Which server it went to matters when it is not Agent Code's own:
              a third-party server can expose a tool with the same name. It
              truncates first so a long server name never pushes the verdict
              off a narrow lane (review B3). */}
          {!model.ownServer && <span className="min-w-0 max-w-[30%] truncate font-code text-[11px] text-muted">MCP · {model.server}</span>}
          {model.detail && <span className="min-w-0 flex-1 truncate font-code text-muted">{model.detail}</span>}
          {verdict && (
            <span className={`ml-auto shrink-0 font-code text-[11px] ${verdict.tone}`}>
              <span aria-hidden>{verdict.glyph}{model.code ? ` ${model.code}` : ''}</span>
              <span className="sr-only">{verdict.label}</span>
            </span>
          )}
        </button>
        {model.message && (
          <div className={`ml-5 whitespace-pre-wrap break-words text-[12px] ${model.outcome === 'error' || model.outcome === 'refused' ? 'text-danger' : 'text-muted'}`}>{model.message}</div>
        )}
        {open && (
          <div id={detailsId} className="ml-5 flex flex-col gap-1">
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface px-2 py-1 font-code text-[11px] text-ink-dim">
              {`${model.server} · ${model.tool}\n${argumentsText}`}
            </pre>
            {model.resultText !== null && (
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface px-2 py-1 font-code text-[11px] text-ink-dim">{model.resultText}</pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Glyph for the eye, words for a screen reader (review B6). */
const VERDICT: Record<McpCallModel['outcome'], { glyph: string; tone: string; label: string } | null> = {
  pending: { glyph: '◌', tone: 'text-accent', label: 'running' },
  'no-result': null,
  ok: { glyph: '✓', tone: 'text-ink-dim', label: 'succeeded' },
  refused: { glyph: '✕ refused', tone: 'text-danger', label: 'refused' },
  error: { glyph: '✕ error', tone: 'text-danger', label: 'failed' },
  declined: { glyph: 'declined', tone: 'text-muted', label: 'declined by the user' },
  content: null,
}
