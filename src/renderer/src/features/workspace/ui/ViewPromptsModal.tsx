import { useEffect, useMemo, useRef } from 'react'

import { extractLatestUserPrompts } from '../lib/latestUserPrompts'
import type { Workspace } from '../../../tiles/workspaceStore'
import type { SessionId } from '../../../tiles/types'

type Props = {
  open: boolean
  sessionId: SessionId | null
  workspace: Workspace
  onClose: () => void
}

const PROMPT_LIMIT = 15

function formatPromptTimestamp(timestamp: string | null): string {
  if (!timestamp) return 'Unknown time'
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) return 'Unknown time'
  return parsed.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ViewPromptsModal({
  open,
  sessionId,
  workspace,
  onClose,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null
  const runtime = sessionId ? workspace.getRuntime(sessionId) : null

  const prompts = useMemo(() => {
    if (!meta || !runtime) return []
    return extractLatestUserPrompts(runtime.entries, meta.kind, PROMPT_LIMIT)
  }, [meta, runtime])

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => scrollerRef.current?.focus())
  }, [open])

  if (!open || !meta || !runtime) return null

  const cwdBase = meta.cwd.split('/').filter(Boolean).pop() ?? meta.cwd

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-[min(760px,92vw)] max-h-[82vh] overflow-hidden bg-surface border border-border-hi">
        <div className="border-b border-border px-4 py-3">
          <div className="text-[13px] text-ink">Latest User Prompts</div>
          <div className="mt-1 text-[11px] text-muted">
            {meta.kind ?? 'claude'} · {cwdBase}
          </div>
          <div className="mt-0.5 text-[10px] text-muted truncate">{meta.cwd}</div>
        </div>

        <div
          ref={scrollerRef}
          tabIndex={-1}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
          className="max-h-[calc(82vh-112px)] overflow-y-auto px-4 py-3 outline-none"
        >
          {prompts.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-muted">
              No visible user prompts found for this session.
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {prompts.map((prompt, index) => (
                <div key={`${prompt.timestamp ?? 'unknown'}:${index}`} className="border border-border bg-canvas/70 px-3 py-3">
                  <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.12em] text-muted">
                    <span>#{index + 1}</span>
                    <span>{formatPromptTimestamp(prompt.timestamp)}</span>
                  </div>
                  <div className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-5 text-ink">
                    {prompt.text}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-border px-4 py-3 flex items-center justify-between gap-3">
          <div className="text-[11px] text-muted">
            Showing the latest {Math.min(PROMPT_LIMIT, prompts.length)} prompts
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-[12px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
