import { useRef } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { KbdLegend } from '@renderer/components/ui/kbd'
import { useListNavigation } from '@renderer/lib/useListNavigation'
import { withVisibleControls } from '@shared/text/visibleControls'
import type { SessionMoveTarget } from '@shared/types/sessionMove'

type Props = {
  open: boolean
  /** Who is being moved, for the user to check before choosing. */
  sessionLabel: string
  /** How many related agents move with it (linked and orchestration children). */
  relatedCount: number
  /** The parent this agent leaves behind when it is itself a child, or null. */
  parentLabel: string | null
  /** Null while the window list is loading. */
  targets: SessionMoveTarget[] | null
  onCancel: () => void
  onPick: (windowId: string) => void
}

/**
 * Send to Window… (#1481): pick the open window an agent moves to.
 *
 * WHY a dialog and not a palette sub-mode: the same picker opens from the
 * Sessions right-click menu, where the palette is not open at all, and it
 * composes `DialogContent` so Escape, the focus trap and app input ownership
 * come from the one primitive that owns them (components/ui/README.md). It
 * follows New Agent In…'s list conventions (listbox owns focus, rows are not
 * tab stops, held Enter is swallowed) for the reasons written there.
 *
 * WHY each row names its projects and agent count: every Agent Code window has
 * the same OS title, so "Window 2" alone matches nothing on screen. Project
 * titles are what a person actually sees in that window's tab bar.
 */
export function SendToWindowDialog({ open, sessionLabel, relatedCount, parentLabel, targets, onCancel, onPick }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null)
  // One-shot latch: `open` only drops once the parent reacts to onPick, so a
  // fast second Enter would otherwise start a second move of the same agent
  // (main refuses it, but the user would see a confusing failure toast).
  const committingRef = useRef(false)
  if (!open) committingRef.current = false
  const rows = targets ?? []
  const keys = rows.map(target => target.windowId)
  // The other window the user was in most recently is the likeliest
  // destination, so it starts highlighted; otherwise the first.
  const focusedIndex = rows.findIndex(target => target.lastFocused)
  const nav = useListNavigation({
    count: rows.length,
    keys,
    resetKey: `${open}:${keys.join(',')}`,
    initialIndex: focusedIndex >= 0 ? focusedIndex : 0,
    onActivate: index => {
      const target = rows[index]
      if (target) commit(target.windowId)
    },
    idPrefix: 'send-to-window',
  })

  function commit(windowId: string) {
    if (committingRef.current) return
    committingRef.current = true
    onPick(windowId)
  }

  const highlighted = rows[nav.index] ?? null

  return (
    <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) onCancel() }}>
      <DialogContent
        onOpenAutoFocus={event => {
          // Focus the LISTBOX (focus-owner invariant, useListNavigation): a
          // focused row button would turn Enter into a click on the first row.
          event.preventDefault()
          listRef.current?.focus()
        }}
        onKeyDown={event => {
          // Held Enter auto-repeats; one long press must not pick twice.
          if (event.key === 'Enter' && event.repeat) {
            event.preventDefault()
            return
          }
          nav.onKeyDown(event)
        }}
      >
        <DialogHeader>
          <DialogTitle>Send to Window</DialogTitle>
          <DialogDescription>
            {withVisibleControls(sessionLabel)}
            {relatedCount > 0 ? ` and ${relatedCount} related agent${relatedCount === 1 ? '' : 's'}` : ''}
            {' '}moves to the window you choose and appears in its focused lane. Nothing restarts.
          </DialogDescription>
        </DialogHeader>

        {parentLabel !== null ? (
          // #1481 review: moving a CHILD alone splits it from its parent. The
          // parent's orchestration tools (wait, read, close) and the linked
          // close rule only see agents in their own window, so the user is
          // told before choosing, rather than finding the parent's run lost.
          <div className="px-4 pt-2 text-[11px] leading-snug text-muted">
            It leaves its parent, {withVisibleControls(parentLabel)}, in this window. The parent can no longer
            read, wait on or close it.
          </div>
        ) : null}

        <div className="px-4 py-3">
          <div
            ref={listRef}
            role="listbox"
            tabIndex={0}
            aria-label="Window"
            aria-activedescendant={nav.activeId}
            className="rounded-slab overflow-hidden border border-border bg-canvas outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
          >
            {targets === null ? (
              <div className="px-3 py-8 text-center text-[12px] text-muted">Finding windows&hellip;</div>
            ) : rows.length === 0 ? (
              // The command cannot know the window count synchronously (it is
              // main's), so the empty case is answered here, by naming the
              // command that fixes it rather than a dead end.
              <div className="px-3 py-8 text-center text-[12px] text-muted">
                No other Agent Code window is open. Open one with New Window, then try again.
              </div>
            ) : (
              rows.map((target, index) => {
                const focused = index === nav.index
                const projects = target.projectTitles.length > 0 ? target.projectTitles.join(', ') : 'No projects yet'
                return (
                  <button
                    key={target.windowId}
                    type="button"
                    {...nav.getItemProps(index)}
                    role="option"
                    aria-selected={focused}
                    tabIndex={-1}
                    data-send-to-window={target.windowId}
                    className={`
                      w-full cursor-pointer border-b border-l-2 border-border px-3 py-2 text-left last:border-b-0
                      ${focused ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent bg-transparent hover:bg-row-hover-bg'}
                    `}
                  >
                    <div className="text-[12px] font-medium text-ink">Window {target.number}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted">
                      {withVisibleControls(projects)} · {target.sessionCount} {target.sessionCount === 1 ? 'session' : 'sessions'}
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>

        <DialogActions
          confirmLabel="Send"
          onConfirm={() => { if (highlighted) commit(highlighted.windowId) }}
          onCancel={onCancel}
          // The list owns Enter (with the repeat guard above).
          confirmOnEnter={false}
          confirmDisabled={!highlighted}
          legend={<KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }]} />}
        />
      </DialogContent>
    </Dialog>
  )
}
