import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { ConversationPrompt } from '@shared/conversations/types'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { PromptList } from '@renderer/features/conversations/ui/PromptList'
import { extractLatestUserPrompts } from '@renderer/features/workspace/lib/latestUserPrompts'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'

// ViewPromptsModal — every user prompt of the focused session, newest first.
//
// WHY the transcript on disk rather than runtime.entries: the feed bootstraps
// a tail window, and the old modal paged older history until it had fifteen
// prompts, then said "Showing the latest 15". The whole conversation is what
// the user asked to see (2026-09-11: "capping the view prompts command is
// just pure stupid"), and the catalog reads it through the same incremental
// folder the picker's search uses, unwrapped the same way. A pane that has no
// durable transcript yet still shows what the feed holds, uncapped.

type Props = {
  open: boolean
  sessionId: SessionId | null
  workspace: Workspace
  onClose: () => void
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
  const provider = meta?.kind
  const providerSessionId = meta ? resumableProviderSessionId(meta) : undefined
  const cwd = meta?.cwd ?? null
  const [fromDisk, setFromDisk] = useState<ConversationPrompt[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (!cwd || !providerSessionId || !isAgentProviderKind(provider)) {
      setFromDisk(null)
      setLoadError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    window.api.listConversationPrompts({ provider, nativeId: providerSessionId, cwd })
      .then(next => {
        if (!cancelled) setFromDisk(next)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setFromDisk(null)
        setLoadError(error instanceof Error && error.message.length > 0 ? error.message : 'Could not read prompts.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, cwd, provider, providerSessionId])

  const fromFeed = useMemo(() => {
    if (!meta || !runtime) return []
    return extractLatestUserPrompts(runtime.entries, meta.kind).map(p => ({
      text: p.text,
      timestamp: p.timestamp ? Date.parse(p.timestamp) : null,
    }))
  }, [meta, runtime])

  // Both come newest first: the catalog's folder returns prompts in that
  // order and extractLatestUserPrompts reverses its chronological walk.
  const prompts = fromDisk ?? fromFeed

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
          <DialogTitle>User Prompts</DialogTitle>
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
          {loadError && (
            <div role="alert" className="mb-3 rounded-slab border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {loadError}
            </div>
          )}
          <PromptList
            prompts={prompts}
            emptyMessage={loading ? 'Reading prompts…' : 'No visible user prompts found for this session.'}
          />
        </div>

        <DialogFooter className="justify-between">
          <div className="text-[11px] text-muted">
            {loading ? 'Loading prompts…' : `${prompts.length} ${prompts.length === 1 ? 'prompt' : 'prompts'}`}
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
