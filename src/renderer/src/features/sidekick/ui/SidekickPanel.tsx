import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { Button } from '@renderer/components/ui/button'
import { SplitHandle } from '@renderer/features/shared/SplitHandle'
import { useResizableSplitter } from '@renderer/features/shared/useResizableSplitter'
import { sidekickPlace } from '@renderer/features/sidekick/actions/useSidekickActions'
import type { SidekickActions } from '@renderer/features/sidekick/actions/useSidekickActions'
import { useSidekickSummaries } from '@renderer/features/sidekick/state/sidekickIndexStore'
import { confirmRemoveSidekick } from '@renderer/features/sidekick/ui/confirmRemoveSidekick'
import { sidekickChipLabel, SidekickStrip } from '@renderer/features/sidekick/ui/SidekickStrip'
import { useSidekickSpotlightActive } from '@renderer/features/sidekick/state/sidekickSpotlight'
import { KeyboardRegionContext, SIDEKICK_PANEL_ATTRIBUTE } from '@renderer/features/sidekick/ui/KeyboardRegionContext'
import { useGlobalToast } from '@renderer/ui/GlobalToastContext'
import { clampSidekickPanelWidth, DEFAULT_SIDEKICK_PANEL } from '@renderer/workspace/sidekickPanel'
import { renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import type { Workspace } from '@renderer/workspace/workspaceStore'

/**
 * The tab id renderWorkspaceLeaf requires. NEVER resolved: the panel always
 * passes both `onFocusRequest` and `surfacePaneLabel`, the two parameters a
 * leaf would otherwise derive from its tab (TileTree.tsx). A sidekick has no
 * project, so there is no real id to pass — a named constant says so instead
 * of an empty string that looks like a bug.
 */
export const SIDEKICK_SURFACE_TAB_ID = 'sidekick'

/** The column's chrome beside the agent: the 10px boundary handle plus the
 *  46px chip strip, the same sizes as a lane's (TiledDispatchLayout). */
const SIDEKICK_COLUMN_CHROME_PX = 10 + 46


type Props = { workspace: Workspace; actions: SidekickActions }

export function SidekickPanel({ workspace, actions }: Props) {
  const panel = workspace.state.sidekickPanel ?? DEFAULT_SIDEKICK_PANEL
  const settings = useAppStore(state => state.settings)
  const region = useAppStore(state => state.keyboardRegion)
  const setRegion = useAppStore(state => state.setKeyboardRegion)
  const openPicker = useAppStore(state => state.openSidekickPicker)
  const { showToast } = useGlobalToast()
  const summaries = useSidekickSummaries()
  const place = sidekickPlace(workspace.state.sessions, panel.sidekickId)
  const [busy, setBusy] = useState<'attaching' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // Width: clamped on every read (sidekickPanel.ts WHY), dragged from the
  // boundary on the panel's LEFT edge. The panel is the rightmost column of
  // the main row, so its width is simply the distance from the pointer to the
  // window's right edge, minus the column's own chrome (handle + strip).
  //
  // WHY the stored width is the AGENT AREA and not the whole column (review
  // of #1507): it was the agent area when the panel was an aside, and every
  // saved workspace.json carries that number. Counting the new 56px of chrome
  // inside it would have shrunk every existing sidekick by 56px and put the
  // clamp's 300px floor at 244px of agent, below what a composer fits.
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const width = clampSidekickPanelWidth(panel.width, windowWidth)
  const splitter = useResizableSplitter({
    axis: 'x',
    onDrag: clientX => workspace.setSidekickPanel({ width: clampSidekickPanelWidth(window.innerWidth - clientX - SIDEKICK_COLUMN_CHROME_PX, window.innerWidth) }),
  })

  // Attach the sidekick as soon as the panel shows it, when no CURRENT lease
  // holds it elsewhere. WHY 'elsewhere' is attempted too (review round 1, F3):
  // after this window's renderer reloads, main still files the lease under
  // this window at the old generation until something re-claims it, and the
  // index can report it as live in a window — this one. Main is the only side
  // that can tell "stale lease of mine" from "really in another window":
  // attach transfers a stale lease and refuses a current one with
  // 'owned-elsewhere', which simply leaves the "Live in another window" state
  // up. A sidekick live in another window is never TAKEN automatically —
  // "Open here" is the explicit move.
  const attachAttempted = useRef<string | null>(null)
  // Retry must re-run this effect; clearing the ref alone changed no dependency
  // (review round 1, F6), so the button did nothing.
  const [attempt, setAttempt] = useState(0)
  // Wait for boot (plan R2): rehydrate's first publish also merges held
  // sidekick rows, so this wait is belt and braces, not load-bearing.
  const bootstrapComplete = workspace.restoreStatus !== 'pending'
  useEffect(() => {
    if (!panel.sidekickId || !bootstrapComplete) return
    if (place.kind !== 'asleep' && place.kind !== 'elsewhere') return
    // Keyed by place too: a sidekick refused as 'elsewhere' must be attached
    // once its window closes and it turns 'asleep'.
    const key = `${panel.sidekickId}:${place.kind}:${attempt}`
    if (attachAttempted.current === key) return
    attachAttempted.current = key
    setBusy('attaching')
    setFailure(null)
    void actions.showSidekick(panel.sidekickId)
      .then(result => { if (!result.ok && result.reason !== 'owned-elsewhere') setFailure(failureText(result.reason)) })
      .catch(error => setFailure(error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(null))
  }, [actions, attempt, bootstrapComplete, panel.sidekickId, place.kind])

  // Move the caret into the sidekick whenever it owns the keyboard (F2,
  // fixed for real in the focus follow-up).
  //
  // WHY the panel does this and not TileLeaf: TileLeaf focuses its input only
  // when its `focused` prop CHANGES or focus is unowned. ⌘J (and a chip click,
  // and the picker) set the region programmatically while the caret still
  // sits in the lane's composer — focus is OWNED, and the sidekick leaf mounts
  // already `focused`, so nothing moved it and typing and Enter kept going to
  // the lane while the region said "sidekick".
  //
  // WHY it waits for the input instead of trying once: the first cut looked
  // for a textarea one frame after the row was held. In the app the agent's
  // input is not there yet — the composer mounts after the runtime boots, and
  // xterm creates its helper textarea when the terminal attaches — so it found
  // nothing and never tried again. (Its test used a stand-in leaf that
  // rendered a textarea at once, which is why it passed.) A MutationObserver
  // on the body catches the input the moment it appears.
  //
  // WHAT it focuses: this session's own composer (`data-composer-input`),
  // else xterm's helper textarea in terminal view — never "the first
  // textarea", which could be a queued-prompt editor.
  //
  // It stands down as soon as focus is anywhere inside the body (the user
  // clicked into it, or it worked), and when the region leaves the Sidekick.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const heldSessionId = place.kind === 'here' ? place.sessionId : null
  useEffect(() => {
    if (region !== 'sidekick' || !heldSessionId) return
    const body = bodyRef.current
    if (!body) return
    const claim = (): boolean => {
      if (body.contains(document.activeElement)) return true
      const input = sidekickInputIn(body, heldSessionId)
      if (!input) return false
      input.focus()
      return body.contains(document.activeElement)
    }
    if (claim()) return
    const observer = new MutationObserver(() => {
      if (claim()) observer.disconnect()
    })
    observer.observe(body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [region, heldSessionId])

  const openHere = useCallback(async () => {
    if (!panel.sidekickId) return
    setBusy('attaching')
    setFailure(null)
    try {
      const result = await actions.openHere(panel.sidekickId)
      if (!result.ok) setFailure(failureText(result.reason))
      else setRegion('sidekick')
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }, [actions, panel.sidekickId, setRegion])

  // sidekickId → the session holding it in this window, for the strip's
  // activity colours and the chip menu's Reload.
  const sessions = workspace.state.sessions
  const heldSessions = useMemo(() => {
    const held: Record<string, string> = {}
    for (const [sessionId, meta] of Object.entries(sessions)) {
      if (meta.sidekickId) held[meta.sidekickId] = sessionId
    }
    return held
  }, [sessions])

  // A chip click is the lane chip's gesture: show that sidekick here. It does
  // NOT take a sidekick live in another window (unlike a deliberate pick in
  // the picker, F8): a strip is clicked casually, and stealing an agent out
  // of the window someone is typing in must stay the explicit "Open here".
  const select = useCallback((sidekickId: string) => {
    workspace.setSidekickPanel({ sidekickId })
    setRegion('sidekick')
  }, [setRegion, workspace])

  const hide = useCallback(() => {
    workspace.setSidekickPanel({ open: false })
    setRegion('workspace')
  }, [setRegion, workspace])

  // The actions the old panel header carried as buttons (Reload, Remove,
  // Hide), on the chip's native right-click menu — the same channel and the
  // same "the renderer maps the id back" contract as the Sessions row menu
  // (shared/types/popupMenu.ts). Switch needs no item: it is the chip click.
  const onChipMenu = useCallback(async (sidekickId: string) => {
    const heldSessionId = heldSessions[sidekickId] ?? null
    const choice = await window.api.showPopupMenu({
      items: [
        { type: 'item', id: 'reload', label: 'Reload Agent', enabled: heldSessionId !== null },
        { type: 'item', id: 'spotlight', label: 'Spotlight', checked: useAppStore.getState().sidekickSpotlight },
        { type: 'item', id: 'remove', label: 'Remove Sidekick…' },
        { type: 'separator' },
        { type: 'item', id: 'hide', label: 'Hide Sidekick' },
      ],
    })
    if (choice === 'spotlight') {
      // The menu's way into the same toggle the ⌥S chord runs; it shows the
      // chip's sidekick first so "Spotlight" always means the one clicked.
      const store = useAppStore.getState()
      if (!store.sidekickSpotlight) select(sidekickId)
      store.setSidekickSpotlight(!store.sidekickSpotlight)
    } else if (choice === 'reload' && heldSessionId) void workspace.reloadSessionAgent(heldSessionId)
    else if (choice === 'remove') await confirmRemoveSidekick(actions, sidekickId, showToast)
    else if (choice === 'hide') hide()
  }, [actions, heldSessions, hide, select, showToast, workspace])

  // The strip's own right-click menu, outside any chip. WHY (review of
  // #1507): Hide lived only on a chip's menu, and with no sidekick yet, or
  // after removing the last one, there is no chip — the old header always
  // had a Hide button, so the mouse had lost its way to close the column.
  const onStripMenu = useCallback(async () => {
    const choice = await window.api.showPopupMenu({
      items: [
        { type: 'item', id: 'new', label: 'New Sidekick…' },
        { type: 'separator' },
        { type: 'item', id: 'hide', label: 'Hide Sidekick' },
      ],
    })
    if (choice === 'new') openPicker('create')
    else if (choice === 'hide') hide()
  }, [hide, openPicker])

  const chipIndex = summaries.findIndex(entry => entry.id === panel.sidekickId)
  const paneLabel = chipIndex >= 0 ? sidekickChipLabel(chipIndex) : 'S'
  const focused = region === 'sidekick'
  const spotlit = useSidekickSpotlightActive(workspace.state)

  // The column is shaped exactly like a lane in TiledDispatchLayout: a
  // boundary handle in normal flow, the 46px chip strip, then the leaf on the
  // canvas with the leaf's own PaneHeader as the only header, dimmed like an
  // unfocused lane while the keyboard is in the workspace.
  //
  // WHY the handle is a flex sibling and not absolutely positioned on the
  // panel's edge (the "not even resizable" bug): the first cut put a 10px
  // handle at `left-0 -translate-x-1/2` inside the side-panel aside, whose
  // `overflow-hidden` clipped the outer half. What was left was a 5px strip
  // whose 4px bar was half clipped too and sat on top of the aside's 1px
  // border — no visible affordance and a target almost nobody could hit. In
  // flow, it is the same 10px / 4px boundary every lane-to-lane split uses.
  return (
    <div
      role="region"
      aria-label="Sidekick"
      data-sidekick-spotlight={spotlit ? 'true' : undefined}
      // Sidekick Spotlight: the SAME element grows to fill the row instead of
      // a second surface rendering the leaf. A separate spotlight view would
      // remount the agent (xterm dispose + PTY replay, the #752 cost) on every
      // toggle; changing this box's size is a plain resize, the way a lane
      // resize is.
      className={spotlit ? 'flex h-full min-h-0 min-w-0 flex-1 bg-canvas' : 'flex h-full min-h-0 flex-shrink-0 bg-canvas'}
      style={spotlit ? undefined : { width: width + SIDEKICK_COLUMN_CHROME_PX }}
      {...{ [SIDEKICK_PANEL_ATTRIBUTE]: '' }}
    >
      {/* No boundary while spotlit: there is nothing on its left to share the
          width with. The slot stays (null) so the strip and leaf keep their
          child positions and React never remounts the leaf. */}
      {spotlit ? null : (
        <SplitHandle
          dragging={splitter.dragging}
          onMouseDown={splitter.onMouseDown}
          hitSizePx={10}
          barSizePx={4}
          label="Resize Sidekick"
          valueNow={width}
          onKeyboardDelta={delta => workspace.setSidekickPanel({ width: clampSidekickPanelWidth(width - delta * 16, window.innerWidth) })}
        />
      )}
      {splitter.cursorLock}
      <SidekickStrip
        sidekicks={summaries}
        selectedId={panel.sidekickId}
        heldSessions={heldSessions}
        focused={focused}
        onSelect={select}
        onChipMenu={id => { void onChipMenu(id) }}
        onStripMenu={() => { void onStripMenu() }}
        onNew={() => openPicker('create')}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {place.kind === 'here' ? (
          <KeyboardRegionContext.Provider value="sidekick">
            <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
              {renderWorkspaceLeaf(
                place.sessionId,
                focused ? place.sessionId : null,
                workspace,
                SIDEKICK_SURFACE_TAB_ID,
                settings.agentViewMode,
                settings.showStatusMode,
                settings.showWorktreeBadges,
                () => setRegion('sidekick'),
                paneLabel,
              )}
            </div>
          </KeyboardRegionContext.Provider>
        ) : (
          <SidekickPanelBody
            state={busy === 'attaching' ? 'attaching' : failure ? 'failed' : place.kind === 'elsewhere' ? 'elsewhere' : place.kind === 'none' ? 'empty' : 'attaching'}
            failure={failure}
            onOpenHere={() => { void openHere() }}
            onRetry={() => { setFailure(null); setAttempt(value => value + 1) }}
            onNew={() => openPicker('create')}
          />
        )}
        {/* The unfocused-lane dim, verbatim from TiledDispatchLayout. */}
        {!focused && place.kind === 'here' && (
          <div className="absolute inset-0 pointer-events-none bg-canvas/34 ring-1 ring-inset ring-border" />
        )}
      </div>
    </div>
  )
}

/** The element typing should land in for this sidekick, if it exists yet:
 *  its composer (prose/Hermes views), else xterm's input (terminal view). */
export function sidekickInputIn(body: HTMLElement, sessionId: string): HTMLElement | null {
  const composer = Array.from(body.querySelectorAll<HTMLElement>('[data-composer-input]'))
    .find(element => element.getAttribute('data-composer-input') === sessionId)
  return composer ?? body.querySelector<HTMLElement>('textarea.xterm-helper-textarea')
}

function failureText(reason: string): string {
  switch (reason) {
    case 'owned-elsewhere': return 'This sidekick is live in another window.'
    case 'not-found': return 'This sidekick no longer exists.'
    case 'window-gone': return 'This window could not take the sidekick.'
    default: return reason
  }
}

export function SidekickPanelBody({ state, failure, onOpenHere, onRetry, onNew }: {
  state: 'empty' | 'elsewhere' | 'attaching' | 'failed'
  failure: string | null
  onOpenHere: () => void
  onRetry: () => void
  onNew: () => void
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[12px] text-muted">
      {state === 'empty' ? (
        <>
          <div>No sidekick yet. A sidekick is a global agent that starts in your home folder and stays beside every project.</div>
          <Button size="sm" onClick={onNew}>New Sidekick…</Button>
        </>
      ) : null}
      {state === 'elsewhere' ? (
        <>
          <div>Live in another window.</div>
          <Button size="sm" onClick={onOpenHere}>Open here</Button>
        </>
      ) : null}
      {state === 'attaching' ? <div role="status">Opening sidekick…</div> : null}
      {state === 'failed' ? (
        <>
          <div role="alert">{failure}</div>
          <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
        </>
      ) : null}
    </div>
  )
}
