import { useEffect, useMemo, useRef, useState } from 'react'

import { DialogActions } from '@renderer/components/ui/dialog-actions'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { KbdLegend } from '@renderer/components/ui/kbd'
import { useListNavigation } from '@renderer/lib/useListNavigation'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'
import type { HermesLaneListing } from '@shared/hermes/types'
import { SESSION_START_FAILED_MESSAGE } from '@shared/types/session'

import { hermesThreadChoices, type HermesThreadChoice } from './hermesThreadChoices'

type Props = {
  open: boolean
  sessionId: SessionId | null
  workspace: Workspace
  onClose: () => void
}

/**
 * "Change Telegram Thread…" (#1501): which messaging thread a Hermes pane
 * follows. Same dialog language as Agent View Mode (listbox owns focus and
 * Enter, Apply makes Enter's meaning visible).
 *
 * WHY the swap is a pane REPLACEMENT and not a live retarget of the running
 * HermesSession: the lane is fixed at construction (HermesSession reads
 * `hermesLaneKey` once and hermes-headless pins it as its target), and the
 * pane's whole history, held prompts and pending approvals belong to the
 * thread it was opened on. Reopening is the same path Reload Agent takes, so
 * the new thread gets a clean history reset instead of a mixed transcript.
 */
export function HermesThreadPickerModal({ open, sessionId, workspace, onClose }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const committingRef = useRef(false)
  const meta = sessionId ? workspace.state.sessions[sessionId] : null
  const connectionId = meta?.kind === 'hermes' ? meta.remoteConnectionId ?? null : null
  const currentLaneKey = meta?.hermesLaneKey ?? null
  const [listing, setListing] = useState<HermesLaneListing | null>(null)

  useEffect(() => {
    if (!open || !connectionId) return
    committingRef.current = false
    setListing(null)
    // A stale answer from an earlier opening (another pane, another server)
    // must not paint over this one.
    let live = true
    void window.api.hermesListLanes(connectionId)
      .then((result) => { if (live) setListing(result) })
      .catch((error: unknown) => {
        if (live) setListing({ ok: false, error: error instanceof Error ? error.message : String(error) })
      })
    return () => { live = false }
  }, [open, connectionId, sessionId])

  // The pane went away under the open picker (closed, reloaded from another
  // command, close_run): nothing here can act any more, so close instead of
  // leaving a disabled list on screen (review of #1521, L2).
  useEffect(() => {
    if (open && sessionId && !meta) onClose()
  }, [open, sessionId, meta, onClose])

  // While loading (or after a failure) "Separate chat" is still offered: it
  // needs nothing from the server, and a user leaving a thread because the
  // server's listing is broken should not be stuck on it.
  const choices = useMemo<HermesThreadChoice[]>(
    () => hermesThreadChoices(listing?.ok ? listing.lanes : [], currentLaneKey, listing?.ok === true),
    [listing, currentLaneKey],
  )

  const pick = (choice: HermesThreadChoice) => {
    if (!sessionId || !meta || committingRef.current) return
    if (choice.current) {
      onClose()
      return
    }
    committingRef.current = true
    // Close first, like the provider switch: the pane id is about to be
    // replaced, and a picker still open over it could fire a second swap
    // against a session that no longer exists.
    onClose()
    void (async () => {
      // WHY every outcome is reported on the pane (review of #1521, same
      // rule as the Conversations picker, #1241): the picker is already
      // closed, so a failed swap (the server unreachable, a refused commit)
      // was an unhandled rejection or silence, and the pane just stayed on
      // the old thread. A fixed sentence, never the rejection's text: the
      // spawn error can carry environment values or URLs.
      try {
        const replaced = await workspace.replaceSession(meta.cwd, {
          targetSessionId: sessionId,
          hermesLaneKey: choice.laneKey,
          // A different thread is a different conversation: orchestration
          // parentage and the bootstrap flag must not carry (replaceSession's
          // newConversation note). Position and MCP choices still do.
          newConversation: true,
        })
        if (!replaced) workspace.showPaneToast(sessionId, `Could not switch this pane to ${choice.label}.`)
      } catch {
        workspace.showPaneToast(sessionId, `Could not switch this pane to ${choice.label}: ${SESSION_START_FAILED_MESSAGE}`)
      }
    })()
  }

  const nav = useListNavigation({
    count: choices.length,
    initialIndex: Math.max(0, choices.findIndex((choice) => choice.current)),
    resetKey: `${open}:${sessionId}:${listing ? 'loaded' : 'loading'}`,
    onActivate: (index) => {
      const choice = choices[index]
      if (choice) pick(choice)
    },
    idPrefix: 'hermes-thread',
  })
  const cursor = choices[nav.index]

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          listRef.current?.focus()
        }}
        onKeyDown={nav.onKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Telegram Thread</DialogTitle>
          <DialogDescription>
            {!connectionId
              ? 'Only a Hermes pane follows a messaging thread.'
              : listing === null
              ? 'Loading the threads on this Hermes server…'
              : listing.ok
              ? 'The pane reopens on the thread you choose. Messages you send there also reach your phone.'
              : `Could not list the threads: ${listing.error}`}
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-3">
          <div
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-label="Messaging thread"
            aria-activedescendant={nav.activeId}
            aria-busy={listing === null}
            className="max-h-[50vh] overflow-y-auto rounded-slab border border-border bg-canvas outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
          >
            {choices.map((choice, index) => {
              const focused = index === nav.index
              return (
                <button
                  key={choice.laneKey ?? '<separate>'}
                  type="button"
                  {...nav.getItemProps(index)}
                  role="option"
                  aria-selected={choice.current}
                  // Out of the tab order: the arrow-driven highlight is the
                  // only selection signal (same reasoning as Agent View Mode).
                  tabIndex={-1}
                  disabled={!connectionId}
                  className={`
                    w-full text-left px-3 py-2 border-b border-l-2 border-border last:border-b-0
                    ${focused ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent bg-transparent'}
                    ${connectionId ? 'hover:bg-row-hover-bg cursor-pointer' : 'opacity-45 cursor-not-allowed'}
                  `}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate text-[12px] font-medium text-ink">{choice.label}</span>
                    {choice.current && (
                      <span className="shrink-0 text-[10px] uppercase tracking-wider text-accent">Current</span>
                    )}
                  </div>
                  <div className="mt-1 truncate text-[11px] leading-snug text-muted">{choice.description}</div>
                </button>
              )
            })}
          </div>
        </div>

        <DialogActions
          confirmLabel="Open"
          onConfirm={() => { if (cursor) pick(cursor) }}
          onCancel={onClose}
          confirmOnEnter={false}
          confirmDisabled={!connectionId || !cursor}
          legend={<KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }]} />}
        />
      </DialogContent>
    </Dialog>
  )
}
