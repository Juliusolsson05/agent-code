import { useState } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'

import type { McpCallModel } from './model'

/**
 * One MCP call, one line (model.ts says why). The arguments stay one click
 * away (the line opens to them), so collapsing the old "▸ 1 param" row hides
 * nothing; a refusal or an error shows its own sentence under the line.
 */
export function McpCallRow({ model, block }: { model: McpCallModel; block: ToolUseBlock }) {
  const [open, setOpen] = useState(false)
  const verdict = model.outcome === 'ok'
    ? { text: '✓', tone: 'text-ink-dim' }
    : model.outcome === 'error'
      ? { text: '✕ error', tone: 'text-danger' }
      : model.outcome === 'refused'
        ? { text: '✕ refused', tone: 'text-danger' }
        : model.outcome === 'pending'
          ? { text: '◌', tone: 'text-accent' }
          : null
  return (
    <div className="flex gap-2 py-0.5" data-mcp-call={model.outcome}>
      <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ink-dim" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 items-baseline gap-2 text-left text-[12.5px]"
          title={`${model.server} · ${model.tool}`}
        >
          <span aria-hidden className="w-3 shrink-0 text-center font-code text-muted">◆</span>
          <span className="shrink-0 font-code text-ink">{model.tool}</span>
          {/* Which server it went to matters when it is not Agent Code's own:
              a third-party server can expose a tool with the same name. */}
          {model.server !== 'agent_code' && <span className="shrink-0 font-code text-[11px] text-muted">MCP · {model.server}</span>}
          {model.detail && <span className="min-w-0 truncate font-code text-muted">{model.detail}</span>}
          {verdict && <span className={`ml-auto shrink-0 font-code text-[11px] ${verdict.tone}`}>{verdict.text}</span>}
        </button>
        {model.message && <div className={`ml-5 whitespace-pre-wrap break-words text-[12px] ${model.outcome === 'error' || model.outcome === 'refused' ? 'text-danger' : 'text-ink-dim'}`}>{model.message}</div>}
        {open && (
          <pre className="ml-5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface px-2 py-1 font-code text-[11px] text-ink-dim">
            {`${model.server} · ${model.tool}\n${JSON.stringify(block.input ?? {}, null, 2).slice(0, 16_384)}`}
          </pre>
        )}
      </div>
    </div>
  )
}
