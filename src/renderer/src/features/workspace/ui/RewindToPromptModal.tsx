import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { RewindPrompt } from '@shared/types/transcriptRewind'
import { useEffect, useMemo, useRef, useState } from 'react'

import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { KbdLegend } from '@renderer/components/ui/kbd'
import { useListNavigation } from '@renderer/lib/useListNavigation'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { PromptList } from '@renderer/features/conversations/ui/PromptList'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'
import { resumableProviderSessionId } from '@renderer/workspace/providerSessionIdentity'
import { withVisibleControls } from '@shared/text/visibleControls'

// RewindToPromptModal — picker for the rewind-to-prompt flow.
//
// UX goal: let the user jump back to any past user-prompt in the
// focused session. On select, Agent Code writes a truncated provider
// transcript, re-homes the focused pane onto it, and prefills the
// composer with the anchored prompt in an UNSENT state. The source
// session is never touched.
//
// Parallel to `ViewPromptsModal` (same row component, every prompt, newest
// first) but rows are clickable — each invokes
// `workspace.rewindSessionToPrompt(sessionId, anchor)` and the modal closes.
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

export function RewindToPromptModal({
  open,
  sessionId,
  workspace,
  onClose,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
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
    // No limit: main returns every prompt newest first. A cap of thirty hid
    // the prompt the user wanted to rewind to on any long session.
    void window.api.listRewindPrompts({
      provider,
      sourceProviderSessionId: providerSessionId,
      cwd,
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

  // The shared list keys (plan K5): ↑↓ ⌃N⌃P Home End PgUp PgDn Enter, clamp
  // when the list shrinks, hover via mousemove, scroll-into-view. Declared
  // before the early return below because hooks cannot follow it; `confirm`
  // is a hoisted function declaration, called only at event time.
  const nav = useListNavigation({
    count: prompts.length,
    resetKey: `${open}:${sessionId}`,
    onActivate: index => void confirm(index),
    idPrefix: 'rewind-prompt',
  })
  const selectedIndex = nav.index

  // Prompts load asynchronously, so at open there is no listbox yet and the
  // scroller holds focus (see onOpenAutoFocus). When the list arrives, hand
  // focus to the listbox — the only element whose aria-activedescendant is
  // announced — but only if focus is still parked on the scroller, so a user
  // who already tabbed to Cancel is not yanked back.
  const hasPrompts = prompts.length > 0
  useEffect(() => {
    if (!open || !hasPrompts) return
    if (document.activeElement === scrollerRef.current) listRef.current?.focus()
  }, [hasPrompts, open])

  // The list renders text and time; the address stays in `prompts` at the
  // same index, which is what confirm() reads.
  const rows = useMemo(
    // Escaped HERE rather than in PromptList, because the same component is
    // also the read-only View Prompts surface where the raw text is the
    // point. In this modal a click rewinds the live pane to that prompt, so
    // two rows that read alike are two different destinations (#1049
    // re-review). The address dispatched below is untouched.
    () => prompts.map(prompt => ({
      text: withVisibleControls(prompt.text),
      timestamp: prompt.timestamp ? Date.parse(prompt.timestamp) : null,
    })),
    [prompts],
  )

  if (!meta) return null

  const cwdBase = meta.cwd.split('/').filter(Boolean).pop() ?? meta.cwd
  const selected = prompts[selectedIndex] ?? null

  // Takes the index explicitly so a click confirms the clicked row even when
  // the highlight state has not caught up with it in this render.
  async function confirm(index = selectedIndex) {
    const target = prompts[index] ?? null
    if (!target || !sessionId) return
    onClose()
    // The session this modal was opened FOR, not whichever agent is focused
    // now (#1180). rewindFocusedToPrompt re-resolved focus at confirm time: if
    // focus moved while the modal was open — or the modal was opened from the
    // Sessions right-click menu for an agent that was never focused — it
    // rewound a different agent than the one whose prompts were listed.
    await workspace.rewindSessionToPrompt(sessionId, target.address)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        size="lg"
        className="flex max-h-[82vh] flex-col overflow-hidden"
        onOpenAutoFocus={event => {
          // The LISTBOX is the focus owner (it carries aria-activedescendant —
          // focus-owner invariant, useListNavigation). While prompts are still
          // loading there is no listbox yet; the scroller takes focus and the
          // key handler below (on the scroller, bubbling) works either way.
          event.preventDefault()
          ;(listRef.current ?? scrollerRef.current)?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Rewind to Prompt</DialogTitle>
          <DialogDescription asChild>
            <div>
              {/* Names the session whose history is about to be discarded
                  back to a chosen prompt (#1049 re-review). */}
              <div>{meta.kind ?? DEFAULT_PROVIDER} · {withVisibleControls(cwdBase)}</div>
              <div className="mt-0.5 truncate text-[10px]">{withVisibleControls(meta.cwd)}</div>
              {/* Moved up from the footer, where it shared a two-line left
                  slot with the count; it is the one sentence a user must read
                  BEFORE pressing Enter, so it belongs above the list. */}
              <div className="mt-1 text-[11px]">
                Choosing a prompt rewinds this pane to that point. The original transcript is not touched.
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div
          ref={scrollerRef}
          tabIndex={-1}
          onKeyDown={nav.onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-3 outline-none"
        >
          <PromptList
            prompts={rows}
            nav={nav}
            listRef={listRef}
            label="Prompts to rewind to"
            emptyMessage={loading ? 'Reading transcript prompts…' : loadError ?? 'No rewindable prompts found for this session.'}
          />
        </div>

        {/* Chips on the buttons that perform Escape and Enter; ↑↓ is the
            only legend item (plan H2/H3). confirmOnEnter={false}: the list
            owns Enter. */}
        <DialogActions
          confirmLabel="Rewind Here"
          onConfirm={() => void confirm()}
          onCancel={onClose}
          confirmOnEnter={false}
          confirmDisabled={!selected}
          legend={<KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }]} />}
        >
          {loading ? 'Reading transcript prompts…' : `${prompts.length} prompt${prompts.length === 1 ? '' : 's'}`}
        </DialogActions>
      </DialogContent>
    </Dialog>
  )
}
