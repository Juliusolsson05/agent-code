import type { SessionId, Tab, TabId } from '@renderer/workspace/types'
import { collectLeaves } from '@renderer/workspace/tile-tree/treeOps'

export function tabIndexLabel(index: number): string {
  if (index < 0) return '?'
  let n = index
  let label = ''
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

export function paneLabelForSession(
  tabs: Tab[],
  tabId: TabId,
  sessionId: SessionId,
): string {
  const tabIndex = tabs.findIndex(tab => tab.id === tabId)
  const tab = tabIndex >= 0 ? tabs[tabIndex] : null
  if (!tab) return '?'
  const paneIndex = collectLeaves(tab.root).indexOf(sessionId)
  return `${tabIndexLabel(tabIndex)}${paneIndex >= 0 ? paneIndex + 1 : '?'}`
}
