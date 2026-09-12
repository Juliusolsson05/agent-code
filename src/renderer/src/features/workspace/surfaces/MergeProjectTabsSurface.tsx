import { useMemo } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { MergeProjectTabsModal } from '@renderer/features/workspace/ui/MergeProjectTabsModal'
import type { MergeTabOption } from '@renderer/features/workspace/ui/MergeProjectTabsModal'
import { resolveTabSessions } from '@renderer/workspace/queries'
import { cwdBasename } from '@renderer/workspace/sessionDisplayTitle'
import { tabIndexLabel } from '@renderer/workspace/tile-tree/paneLabelFormat'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// The surface owns only the modal chrome; the merge itself is the workspace
// action, so autosave records the result exactly like any other layout change.
export function MergeProjectTabsSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.mergeProjectTabsOpen)
  const close = useAppStore(state => state.closeMergeProjectTabs)
  const { state } = workspace

  const tabs = useMemo<MergeTabOption[]>(() => state.tabs.map((tab, index) => {
    const sessionIds = resolveTabSessions(state, tab.id)
    const cwds = [...new Set(sessionIds.flatMap(id => state.sessions[id]?.cwd ?? []))]
    return {
      id: tab.id,
      label: `${tabIndexLabel(index)} · ${tab.title}`,
      cwds,
      directories: [...new Set(cwds.map(cwdBasename))],
      sessionCount: sessionIds.length,
    }
  }), [state])

  return (
    <MergeProjectTabsModal
      open={open}
      tabs={tabs}
      initialTargetId={state.activeTabId}
      onCancel={close}
      onConfirm={(targetId, sourceIds) => {
        workspace.mergeTabs(targetId, sourceIds)
        close()
      }}
    />
  )
}
