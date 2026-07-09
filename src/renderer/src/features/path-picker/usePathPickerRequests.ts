import { useCallback } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'

// The "open the new-tab / resume picker" entry points, extracted from
// App.tsx (#494). Both flows share the PathPickerModal; the difference
// is only whether an explicit default cwd seeds the input.
export function usePathPickerRequests(): {
  onNewTabRequest: () => void
  onResumeRequest: (defaultCwd: string) => void
} {
  const openPathPicker = useAppStore(state => state.openPathPicker)
  const setPathPickerDefault = useAppStore(state => state.setPathPickerDefault)

  // New tab flow: show the path modal. On accept the surface wrapper
  // (PathPickerSurface) calls workspace.newTab with the expanded
  // absolute path and closes the modal.
  const onNewTabRequest = useCallback(() => {
    openPathPicker()
  }, [openPathPicker])

  // Resume flow: same modal as new tab, but the default value is the
  // currently-focused tab's cwd so the resume list for that cwd is
  // visible immediately. This is the "continue where I was" shortcut.
  const onResumeRequest = useCallback(
    (defaultCwd: string) => {
      if (defaultCwd) {
        // Pre-fill with the current tab's cwd, bypassing the effect in
        // PathPickerSurface that normally fills from the active tab —
        // this is a direct-to-resume flow and the default MUST reflect
        // where the user is standing.
        setPathPickerDefault(defaultCwd)
      }
      openPathPicker(defaultCwd)
    },
    [openPathPicker, setPathPickerDefault],
  )

  return { onNewTabRequest, onResumeRequest }
}
