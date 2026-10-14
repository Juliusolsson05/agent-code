import { useCallback, useEffect, useRef } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { RetainedWorkspaceSurface } from '@renderer/app/shell/RetainedWorkspaceSurface'
import { useSidekickActions } from '@renderer/features/sidekick/actions/useSidekickActions'
import { useSidekickPersistence } from '@renderer/features/sidekick/actions/useSidekickPersistence'
import { useSidekickIndexStore } from '@renderer/features/sidekick/state/sidekickIndexStore'
import { useSidekickIndexSync } from '@renderer/features/sidekick/state/useSidekickIndexSync'
import { useKeyboardRegionFollowsPointer } from '@renderer/features/sidekick/ui/KeyboardRegionContext'
import { SidekickPanel } from '@renderer/features/sidekick/ui/SidekickPanel'
import { SidekickPicker } from '@renderer/features/sidekick/ui/SidekickPicker'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import type { SidekickIndexView, SidekickReleasedEvent } from '@shared/sidekicks/types'

/**
 * The Sidekick panel's slot in the window (#1493), registered LAST in
 * `sidePanelSurfaces` so it is the rightmost column of the main row.
 *
 * WHY this surface renders even while the panel is closed (returning only
 * the picker, or nothing visible): it owns three window-wide duties that must
 * not stop when the panel is hidden —
 *   - the index sync and the `sidekick:released` listener (another window can
 *     move a sidekick away from this one at any time, and the row must be
 *     dropped when it does);
 *   - persistence of any held sidekick row to main;
 *   - the keyboard-region listener.
 * The lane layout is untouched: this is one more entry in the sanctioned side
 * panel registry (App.tsx's "no new surfaces here" contract).
 */
export function SidekickPanelSurface() {
  const workspace = useWorkspaceContext()
  const actions = useSidekickActions(workspace)
  const open = workspace.state.sidekickPanel?.open === true
  const settingsPageOpen = useAppStore(state => state.settingsPageOpen)
  const setRegion = useAppStore(state => state.setKeyboardRegion)

  // `actions` changes identity with the workspace snapshot; the sync hook
  // subscribes once, so it gets a stable relay to the latest handler.
  const releasedRef = useRef(actions.onReleased)
  releasedRef.current = actions.onReleased
  const onReleased = useCallback((event: SidekickReleasedEvent) => releasedRef.current(event), [])
  useSidekickIndexSync(onReleased)
  useSidekickPersistence()

  useKeyboardRegionFollowsPointer()

  // Scrub the panel pointer against the index (review round 1, F4). The
  // pointer is persisted in this window's slice; the sidekick it names can be
  // removed from ANOTHER window, or vanish with a hand-edited workspace.json,
  // and the panel then showed "No sidekick yet" with a remove button for a
  // ghost. Once the index has loaded, a pointer it does not list moves to the
  // most recently active sidekick, or clears. A row this window still holds
  // keeps the pointer: the index broadcast can trail this window's own
  // register by a tick.
  const view = useSidekickIndexStore(state => state.view)
  const pointer = workspace.state.sidekickPanel?.sidekickId ?? null
  const holdsPointer = pointer !== null && Object.values(workspace.state.sessions).some(meta => meta.sidekickId === pointer)
  useEffect(() => {
    const next = scrubbedPanelPointer(view, pointer, holdsPointer)
    if (next !== pointer) workspace.setSidekickPanel({ sidekickId: next })
  }, [holdsPointer, pointer, view, workspace])

  // A hidden panel cannot own the keyboard — closed, or retained under
  // Settings (below). Without the second case, typing into a Settings field
  // would still have the keyboard gate routing only Sidekick chords.
  useEffect(() => {
    if (!open || settingsPageOpen) setRegion('workspace')
  }, [open, settingsPageOpen, setRegion])

  // A hidden panel cannot be spotlit either. Without this, hiding the
  // Sidekick (⌘J, the Hide menu item) while it filled the window would leave
  // the flag up, and the next ⌘J would reopen it full-window. Settings does
  // not clear it: Settings covers both, and Esc out of Settings should return
  // to the sidekick spotlight the user was in.
  const setSidekickSpotlight = useAppStore(state => state.setSidekickSpotlight)
  useEffect(() => {
    if (!open) setSidekickSpotlight(false)
  }, [open, setSidekickSpotlight])

  // WHY the panel hides while Settings is open (#1493 follow-up): Settings is
  // a takeover of the WORKSPACE — MainSurface retains the lanes under
  // display:none — and the Sidekick is a lane-shaped column beside them. It
  // used to keep painting next to Settings as if it sat on a layer above the
  // configuration page. It is hidden the same way the lanes are, through
  // RetainedWorkspaceSurface, and for the same reason (#752): unmounting would
  // dispose the sidekick's xterm and replay its PTY on every Settings toggle,
  // and the terminal visibility provider stops a hidden pane from sending a
  // zero-sized resize.
  //
  // WHY Reader Mode and Spotlight do NOT hide it: those are ways of looking
  // at the workspace's agents, and the sidekick is the agent kept beside
  // whatever you are looking at. Settings is the one takeover where the user
  // is configuring the app, not working with agents.
  return (
    <>
      {open ? (
        <RetainedWorkspaceSurface hidden={settingsPageOpen}>
          <SidekickPanel workspace={workspace} actions={actions} />
        </RetainedWorkspaceSurface>
      ) : null}
      <SidekickPicker workspace={workspace} actions={actions} />
    </>
  )
}

/** The panel pointer after scrubbing it against the index (see the effect
 *  above). Pure and exported so the rule is tested without mounting a window. */
export function scrubbedPanelPointer(view: SidekickIndexView | null, pointer: string | null, holdsPointer: boolean): string | null {
  if (!view || pointer === null || holdsPointer) return pointer
  if (view.sidekicks.some(entry => entry.id === pointer)) return pointer
  return [...view.sidekicks].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]?.id ?? null
}
