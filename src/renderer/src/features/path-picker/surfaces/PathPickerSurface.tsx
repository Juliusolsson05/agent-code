import { useCallback, useEffect, useRef } from 'react'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { PathPickerModal } from '@renderer/features/path-picker/ui/PathPickerModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { resolveTabSessions } from '@renderer/workspace/queries'

// Registry wrapper (#494): owns the store + workspace wiring App.tsx
// used to inline for the new-tab / resume path picker. Always mounted
// with an `open` prop — exactly how App mounted it.
export function PathPickerSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.pathPickerOpen)
  const defaultValue = useAppStore(state => state.pathPickerDefault)
  const closePathPicker = useAppStore(state => state.closePathPicker)
  const setPathPickerDefault = useAppStore(state => state.setPathPickerDefault)
  const defaultedRef = useRef(false)

  // Pre-fill the path input once per modal open. Do not keep syncing
  // while the modal is visible: newTab/resume mutates workspace
  // sessions before the modal closes, and re-syncing here resets the
  // picker mid-submit. Also preserve explicit defaults from the
  // resume shortcut.
  useEffect(() => {
    if (!open) {
      defaultedRef.current = false
      return
    }
    if (defaultedRef.current) return
    defaultedRef.current = true
    if (defaultValue) return

    let cancelled = false
    // Pre-fill from the active tab's context, not a global "most
    // recent session" walk. The old code did
    // `Object.values(state.sessions).pop()` which returns the last
    // inserted session across ALL tabs — once Dispatch Mode landed,
    // that's frequently a background detached agent in a different
    // project, and the user opens the new-tab picker pre-filled with
    // a directory they aren't standing in. Prefer (a) the active
    // tab's focused session, (b) the first session resolved for the
    // active tab by the canonical resolver. Falls through to
    // window.api.defaultCwd() when the active tab has no sessions.
    const activeTabId = workspace.activeTab?.id
    let fallbackCwd: string | undefined
    if (activeTabId) {
      const focusedId = workspace.activeTab?.focusedSessionId ?? null
      const candidateId = focusedId ?? resolveTabSessions(workspace.state, activeTabId)[0] ?? null
      if (candidateId) {
        fallbackCwd = workspace.state.sessions[candidateId]?.cwd
      }
    }
    if (fallbackCwd) {
      setPathPickerDefault(fallbackCwd)
      return
    }
    void window.api.defaultCwd().then(cwd => {
      if (!cancelled) setPathPickerDefault(cwd)
    })
    return () => {
      cancelled = true
    }
  }, [defaultValue, open, setPathPickerDefault, workspace.activeTab, workspace.state])

  const onAccept = useCallback(
    async (cwd: string, provider?: AgentProviderKind) => {
      await workspace.newTab(cwd, undefined, provider)
      closePathPicker()
    },
    [closePathPicker, workspace],
  )

  const onResume = useCallback(
    async (cwd: string, sessionId: string, provider: AgentProviderKind) => {
      // Resume reuses newTab's plumbing — same workspace entry, same
      // tile tree shape — but passes the resume id through to the
      // spawn call so main spawns the selected provider with its
      // provider-native resume command.
      await workspace.newTab(cwd, sessionId, provider)
      closePathPicker()
    },
    [closePathPicker, workspace],
  )

  return (
    <PathPickerModal
      open={open}
      defaultValue={defaultValue}
      onCancel={closePathPicker}
      onAccept={onAccept}
      onResume={onResume}
    />
  )
}
