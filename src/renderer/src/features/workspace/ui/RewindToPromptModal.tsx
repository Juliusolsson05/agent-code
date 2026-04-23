import { useEffect, useMemo, useRef, useState } from 'react'

import { extractAnchoredUserPrompts } from '../lib/latestUserPrompts'
import type { Workspace } from '../../../workspace/workspaceStore'
import type { SessionId } from '../../../workspace/types'

// RewindToPromptModal — picker for the rewind-to-prompt flow.
//
// UX goal: let the user jump back to any past user-prompt in the
// focused session. On select, cc-shell writes a truncated provider
// transcript, re-homes the focused pane onto it, and prefills the
// composer with the anchored prompt in an UNSENT state. The source
// session is never touched.
//
// Parallel to `ViewPromptsModal` (same data source, same paging
// behavior) but rows are clickable — each invokes
// `workspace.rewindFocusedToPrompt(anchor)` and the modal closes.
// Keyboard navigation mirrors the other command palette family
// (Up/Down to move, Enter to confirm, Esc to close).
//
// WHY re-use the picker list shape from View Prompts instead of
// writing a richer UI:
//   1. The two features have identical "which prompt" semantics.
//      The user is answering the same question; the only thing
//      different is what we do with the answer.
//   2. The rewind picker is a low-frequency power-user action. It
//      doesn't warrant special visual treatment; consistency with
//      the surrounding modal family is the design budget.
//
// Paging: `extractAnchoredUserPrompts` only sees `runtime.entries`,
// which for resumed Claude sessions is typically just the last
// ~200 rows. If the user wants to rewind to an older prompt we
// page older history via `workspace.loadOlderHistory(sessionId)`
// while the modal is open, same pattern as `ViewPromptsModal`.

type Props = {
  open: boolean
  sessionId: SessionId | null
  workspace: Workspace
  onClose: () => void
}

const PROMPT_LIMIT = 30

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

export function RewindToPromptModal({
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
    return extractAnchoredUserPrompts(runtime.entries, meta.kind, PROMPT_LIMIT)
  }, [meta, runtime])

  const [selectedIndex, setSelectedIndex] = useState(0)
  // Reset selection when the prompt list grows/shrinks under us.
  useEffect(() => {
    if (prompts.length === 0) {
      setSelectedIndex(0)
      return
    }
    if (selectedIndex >= prompts.length) {
      setSelectedIndex(prompts.length - 1)
    }
  }, [prompts.length, selectedIndex])

  // Paging — same pattern as ViewPromptsModal. Keep fetching older
  // history until the list is full or the provider says there's
  // nothing more on disk. The check is intentionally cheap; the
  // load itself is debounced inside the workspace action.
  useEffect(() => {
    if (!open || !sessionId || !runtime) return
    if (prompts.length >= PROMPT_LIMIT) return
    if (!runtime.hasOlderHistory || runtime.loadingOlderHistory) return
    void workspace.loadOlderHistory(sessionId)
  }, [open, prompts.length, runtime, sessionId, workspace])

  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => scrollerRef.current?.focus())
  }, [open])

  if (!open || !meta || !runtime) return null

  const cwdBase = meta.cwd.split('/').filter(Boolean).pop() ?? meta.cwd
  const selected = prompts[selectedIndex] ?? null

  const confirm = async () => {
    if (!selected) return
    onClose()
    await workspace.rewindFocusedToPrompt(selected.anchor)
  }

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-[min(760px,92vw)] max-h-[82vh] overflow-hidden bg-surface border border-border-hi">
        <div className="border-b border-border px-4 py-3">
          <div className="text-[13px] text-ink">Rewind to Prompt</div>
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
              return
            }
            if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
              e.preventDefault()
              setSelectedIndex(i => Math.min(prompts.length - 1, i + 1))
              return
            }
            if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
              e.preventDefault()
              setSelectedIndex(i => Math.max(0, i - 1))
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              void confirm()
            }
          }}
          className="max-h-[calc(82vh-168px)] overflow-y-auto px-4 py-3 outline-none"
        >
          {prompts.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-muted">
              {runtime.loadingOlderHistory
                ? 'Loading older prompts…'
                : 'No visible user prompts found for this session.'}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {prompts.map((prompt, index) => {
                const isSelected = index === selectedIndex
                return (
                  <button
                    type="button"
                    key={`${prompt.timestamp ?? 'unknown'}:${index}`}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => {
                      setSelectedIndex(index)
                      void confirm()
                    }}
                    className={
                      'text-left border px-3 py-3 cursor-pointer transition-colors ' +
                      (isSelected
                        ? 'border-accent bg-canvas'
                        : 'border-border bg-canvas/70 hover:border-border-hi')
                    }
                  >
                    <div className="flex items-center justify-between gap-3 text-[10px] uppercase tracking-[0.12em] text-muted">
                      <span>#{index + 1}</span>
                      <span>{formatPromptTimestamp(prompt.timestamp)}</span>
                    </div>
                    <div className="mt-2 whitespace-pre-wrap break-words text-[12px] leading-5 text-ink">
                      {prompt.text}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="border-t border-border px-4 py-3 flex items-center justify-between gap-3 text-[11px] text-muted">
          <div className="flex flex-col gap-0.5">
            <span>
              {runtime.loadingOlderHistory && prompts.length < PROMPT_LIMIT
                ? 'Loading older prompts…'
                : `Showing the latest ${Math.min(PROMPT_LIMIT, prompts.length)} prompt${prompts.length === 1 ? '' : 's'}`}
            </span>
            <span className="text-[10px] text-muted/70">
              Selecting a prompt rewinds THIS pane to that point. The original transcript is not touched.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-[12px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={!selected}
              className="px-3 py-1.5 text-[12px] border border-accent text-accent hover:bg-canvas disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Rewind here
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
