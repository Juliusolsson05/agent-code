import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { RewindPrompt } from '@shared/types/transcriptRewind'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'

// RewindToPromptModal — picker for the rewind-to-prompt flow.
//
// UX goal: let the user jump back to any past user-prompt in the
// focused session. On select, Agent Code writes a truncated provider
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
// WHY the rows come from main instead of `runtime.entries`: the renderer feed
// is intentionally lossy. It hides metadata and folds duplicate Codex event /
// response planes. A list position in that view cannot safely identify a raw
// source record. Main returns provider-native source addresses produced by the
// same transcript analysis that rewind later consumes.

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
  const provider = meta?.kind ?? DEFAULT_PROVIDER
  const providerSessionId = meta ? resumableProviderSessionId(meta) : null
  const cwd = meta?.cwd ?? null
  const [prompts, setPrompts] = useState<RewindPrompt[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !cwd) return
    if (!isAgentProviderKind(provider) || !providerSessionId) {
      setPrompts([])
      setLoadError('This pane does not have a resumable provider transcript.')
      return
    }

    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setPrompts([])
    void window.api.listRewindPrompts({
      provider,
      sourceProviderSessionId: providerSessionId,
      cwd,
      limit: PROMPT_LIMIT,
    }).then(next => {
      if (!cancelled) setPrompts(next)
    }).catch(error => {
      if (cancelled) return
      setLoadError(
        error instanceof Error && error.message.length > 0
          ? error.message
          : 'Could not read rewind prompts.',
      )
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [cwd, open, provider, providerSessionId])

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

  if (!meta) return null

  const cwdBase = meta.cwd.split('/').filter(Boolean).pop() ?? meta.cwd
  const selected = prompts[selectedIndex] ?? null

  const confirm = async () => {
    if (!selected) return
    onClose()
    await workspace.rewindFocusedToPrompt(selected.address)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        className="flex max-h-[82vh] w-[min(760px,92vw)] flex-col overflow-hidden"
        onOpenAutoFocus={event => {
          event.preventDefault()
          scrollerRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Rewind to Prompt</DialogTitle>
          <DialogDescription asChild>
            <div>
              <div>{meta.kind ?? DEFAULT_PROVIDER} · {cwdBase}</div>
              <div className="mt-0.5 truncate text-[10px]">{meta.cwd}</div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div
          ref={scrollerRef}
          tabIndex={-1}
          onKeyDown={e => {
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
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3 outline-none"
        >
          {prompts.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-muted">
              {loading
                ? 'Reading transcript prompts…'
                : loadError ?? 'No rewindable prompts found for this session.'}
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

        <DialogFooter className="justify-between text-[11px] text-muted">
          <div className="flex flex-col gap-0.5">
            <span>
              {loading
                ? 'Reading transcript prompts…'
                : `Showing the latest ${Math.min(PROMPT_LIMIT, prompts.length)} prompt${prompts.length === 1 ? '' : 's'}`}
            </span>
            <span className="text-[10px] text-muted/70">
              Selecting a prompt rewinds THIS pane to that point. The original transcript is not touched.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={onClose}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void confirm()}
              disabled={!selected}
            >
              Rewind here
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
