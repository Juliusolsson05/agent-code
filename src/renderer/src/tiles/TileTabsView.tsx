import { TileTree } from './TileTree'
import type { Workspace } from './workspaceStore'

type Props = {
  workspace: Workspace
}

export function TileTabsView({ workspace }: Props) {
  const tileTabs = workspace.tileTabs
  if (!tileTabs) return null

  const tabs = tileTabs.tabIds
    .map(id => workspace.state.tabs.find(t => t.id === id) ?? null)
    .filter((tab): tab is NonNullable<typeof tab> => tab !== null)

  if (tabs.length < 2) return null

  const isVertical = tileTabs.direction === 'vertical'

  return (
    <div
      className={`h-full min-h-0 min-w-0 flex ${isVertical ? 'flex-row' : 'flex-col'} bg-canvas`}
    >
      {tabs.map((tab, index) => {
        const focused = tab.id === tileTabs.focusedTabId
        return (
          <div
            key={tab.id}
            className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden"
          >
            <section
              className={`flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden ${
                index > 0
                  ? isVertical
                    ? 'border-l border-border'
                    : 'border-t border-border'
                  : ''
              }`}
              onMouseDownCapture={() => workspace.focusTiledTab(tab.id)}
            >
              <div
                className={`flex items-center justify-between gap-3 border-b px-3 py-2 flex-shrink-0 ${
                  focused
                    ? 'border-accent bg-accent/10'
                    : 'border-border bg-surface'
                }`}
              >
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold text-ink truncate">
                    {tab.title}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-muted">
                    Tiled Tab
                  </div>
                </div>
              </div>
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <TileTree
                  tabId={tab.id}
                  node={tab.root}
                  focusedSessionId={tab.focusedSessionId}
                  workspace={workspace}
                />
              </div>
            </section>
          </div>
        )
      })}
    </div>
  )
}
