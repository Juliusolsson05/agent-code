import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { editorHasDirtyFiles, useEditorStore } from '@renderer/features/editor/store'
import type { EditorPreviousSurface } from '@renderer/features/editor/types'

function detectPreviousSurface(workspace: Workspace): EditorPreviousSurface {
  if (workspace.tileTabs) return 'tile-tabs'
  if (workspace.readerMode) return 'reader'
  if (workspace.spotlight) return 'spotlight'
  if (workspace.dispatchMode) return 'dispatch'
  return 'grid'
}

function firstSessionInActiveTab(workspace: Workspace): string | null {
  const tab = workspace.activeTab
  if (!tab) return null
  const walk = (node: typeof tab.root): string | null => {
    if (node.type === 'leaf') return node.sessionId
    return walk(node.a) ?? walk(node.b)
  }
  return walk(tab.root)
}

export function enterEditorForWorkspace(workspace: Workspace): boolean {
  const tab = workspace.activeTab
  if (!tab) return false
  const targetSessionId = commandTargetSessionId(workspace) ?? firstSessionInActiveTab(workspace)
  const projectRoot = targetSessionId
    ? workspace.state.sessions[targetSessionId]?.cwd
    : Object.values(workspace.state.sessions)[0]?.cwd
  if (!projectRoot) return false

  useEditorStore.getState().enterEditor({
    tabId: tab.id,
    projectRoot,
    pinnedSessionId: targetSessionId,
    previousSurface: detectPreviousSurface(workspace),
  })
  return true
}

export function closeEditorWithDirtyCheck(): boolean {
  if (editorHasDirtyFiles()) {
    // WHY this starts with a browser-native confirm instead of a custom modal:
    // the first editor slice needs to protect user edits before anything else.
    // A bespoke dirty-files dialog is better UI, but it also adds another
    // transient state machine. confirm() keeps the safety invariant simple while
    // the editor model is still settling.
    const discard = window.confirm('Discard unsaved editor changes?')
    if (!discard) return false
  }
  useEditorStore.getState().closeEditor()
  return true
}
