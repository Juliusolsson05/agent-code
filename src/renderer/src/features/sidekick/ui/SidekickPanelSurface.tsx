import { useCallback, useEffect, useRef } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { useSidekickActions } from '@renderer/features/sidekick/actions/useSidekickActions'
import { useSidekickPersistence } from '@renderer/features/sidekick/actions/useSidekickPersistence'
import { useSidekickIndexSync } from '@renderer/features/sidekick/state/useSidekickIndexSync'
import { useKeyboardRegionFollowsPointer } from '@renderer/features/sidekick/ui/KeyboardRegionContext'
import { SidekickPanel } from '@renderer/features/sidekick/ui/SidekickPanel'
import { SidekickPicker } from '@renderer/features/sidekick/ui/SidekickPicker'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import type { SidekickReleasedEvent } from '@shared/sidekicks/types'

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
  const setRegion = useAppStore(state => state.setKeyboardRegion)

  // `actions` changes identity with the workspace snapshot; the sync hook
  // subscribes once, so it gets a stable relay to the latest handler.
  const releasedRef = useRef(actions.onReleased)
  releasedRef.current = actions.onReleased
  const onReleased = useCallback((event: SidekickReleasedEvent) => releasedRef.current(event), [])
  useSidekickIndexSync(onReleased)
  useSidekickPersistence()

  useKeyboardRegionFollowsPointer()

  // A hidden panel cannot own the keyboard.
  useEffect(() => {
    if (!open) setRegion('workspace')
  }, [open, setRegion])

  return (
    <>
      {open ? <SidekickPanel workspace={workspace} actions={actions} /> : null}
      <SidekickPicker workspace={workspace} actions={actions} />
    </>
  )
}
