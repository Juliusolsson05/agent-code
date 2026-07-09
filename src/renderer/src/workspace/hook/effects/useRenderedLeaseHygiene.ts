import { useEffect } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// workspace/hook/effects/ — effects owned by the workspace layer that
// the composition root mounts once. These are cross-cutting invariants
// over the live workspace object; they are not any single feature's
// concern, so they live with the workspace hook rather than under
// features/. (Folder introduced by #494; deliberately NOT under
// workspace/semantic/ or anything #493's layer-isolation refactor is
// relocating.)
//
// Both effects below moved VERBATIM from App.tsx root scope.
export function useRenderedLeaseHygiene(workspace: Workspace): void {
  const agentViewMode = useAppStore(state => state.settings.agentViewMode)
  const settingsPageOpen = useAppStore(state => state.settingsPageOpen)

  useEffect(() => {
    if (agentViewMode !== 'terminal') return
    // WHY hard Terminal mode force-clears rendered interaction state:
    // Hybrid leases are intentionally allowed to mount TileLeaf for a feature,
    // but Terminal mode is the user's explicit "do not mount Agent Code's
    // rendered agent surface" setting. If a picker lease survives the setting
    // transition, switching back to Hybrid later can resurrect a stale picker
    // that was invisible while Terminal mode was active. Clearing at the app
    // boundary keeps the mode switch semantic: Terminal is an immediate hard
    // reset of rendered-only affordances, not a pause button for them.
    for (const sessionId of Object.keys(workspace.runtimes)) {
      const runtime = workspace.runtimes[sessionId]
      if (runtime?.assistantPicker) workspace.pickerCancel(sessionId)
      if (runtime?.codeBlockPicker) workspace.setCodeBlockPicker(sessionId, null)
      workspace.releaseAllRenderedViewLeases(sessionId)
    }
  }, [agentViewMode, workspace])

  useEffect(() => {
    // NOTE the field is `readerMode`, not `reader` (cross-app audit V1): the
    // workspace object never exposed a `reader` property, so the old guard read
    // `undefined`, collapsed to "spotlight OR settings only", and SKIPPED the
    // lease cleanup whenever Reader Mode was the surface hiding the feed. Reader
    // Mode replaces the feed interaction layer exactly like spotlight/settings,
    // so a surviving Copy-Assistant / Copy-Code-Block picker lease left
    // Escape/Enter/arrows acting on hidden state. This typo class is the reason
    // the cross-app audit calls for a typecheck gate — `workspace.reader`
    // compiled silently because nothing ran `tsc`.
    if (!workspace.readerMode && !workspace.spotlight && !settingsPageOpen) return
    // WHY reader/spotlight/settings clear picker leases:
    // these surfaces hide or replace the feed interaction layer while global
    // keybinds are still alive. If a Copy Assistant or Copy Code Block picker
    // survives underneath them, Escape/Enter/arrows either act on hidden state
    // or force Hybrid to keep TileLeaf mounted for UI the user cannot see.
    // Draft-driven rendering is intentionally unaffected because composer
    // draft text is real user state; picker leases are transient affordances.
    for (const sessionId of Object.keys(workspace.runtimes)) {
      const runtime = workspace.runtimes[sessionId]
      if (runtime?.assistantPicker) workspace.pickerCancel(sessionId)
      if (runtime?.codeBlockPicker) workspace.setCodeBlockPicker(sessionId, null)
      workspace.releaseRenderedViewLease(sessionId, 'copy-assistant-message')
      workspace.releaseRenderedViewLease(sessionId, 'copy-code-block')
    }
  }, [settingsPageOpen, workspace])
}
