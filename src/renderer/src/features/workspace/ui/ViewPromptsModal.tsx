import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { useEffect, useMemo, useRef } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { extractLatestUserPrompts } from '@renderer/features/workspace/lib/latestUserPrompts'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'

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

  // The feed only bootstraps the recent tail of a resumed session.
  // If the user opens "View Prompts" on a long conversation, the
  // in-memory runtime may initially contain only the last couple of
  // prompts even though many older prompts exist on disk. While the
  // modal is open, keep paging older history until we've collected a
  // reasonable prompt set or the provider says there's nothing left.
  useEffect(() => {
    if (!open || !sessionId || !runtime) return
    if (prompts.length >= PROMPT_LIMIT) return
    if (!runtime.hasOlderHistory || runtime.loadingOlderHistory) return
    void workspace.loadOlderHistory(sessionId)
  }, [
    open,
    prompts.length,
    runtime,
    sessionId,
    workspace,
  ])

  if (!meta || !runtime) return null

  const cwdBase = meta.cwd.split('/').filter(Boolean).pop() ?? meta.cwd

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
          // WHY focus the scroll region instead of the first footer button:
          // this surface is primarily a reading/scrolling tool. Radix still
          // owns trapping/restoration; we only select the useful initial node.
          event.preventDefault()
          scrollerRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Latest User Prompts</DialogTitle>
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
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3 outline-none"
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

        <DialogFooter className="justify-between">
          <div className="text-[11px] text-muted">
            {runtime.loadingOlderHistory && prompts.length < PROMPT_LIMIT
              ? 'Loading older prompts…'
              : `Showing the latest ${Math.min(PROMPT_LIMIT, prompts.length)} prompts`}
          </div>
          <Button
            type="button"
            onClick={onClose}
            variant="outline"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
