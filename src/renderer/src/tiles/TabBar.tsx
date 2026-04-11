import type { Workspace } from './workspaceStore'

// TabBar — one row of tab chrome at the top of the window. Each tab has
// a title, a close button, and activates on click. The `+` button opens
// the new-tab flow (pickDirectory → newTab).

type Props = {
  workspace: Workspace
  onNewTabRequest: () => void
}

export function TabBar({ workspace, onNewTabRequest }: Props) {
  const { state, activateTab, closeTab } = workspace

  return (
    <div
      className="
        flex items-stretch
        bg-surface border-b border-border
        flex-shrink-0
        select-none
        [-webkit-app-region:drag]
      "
    >
      {/* Traffic-light padding on macOS. Keeps the first tab from
          sitting under the red/yellow/green circles. */}
      <div className="w-[70px] flex-shrink-0" />

      {/* Tab list */}
      <div className="flex items-stretch flex-1 min-w-0 [-webkit-app-region:no-drag]">
        {state.tabs.map(tab => {
          const active = tab.id === state.activeTabId
          return (
            <div
              key={tab.id}
              onClick={() => activateTab(tab.id)}
              className={`
                group
                flex items-center gap-2
                px-3 py-2
                min-w-[120px] max-w-[220px]
                border-r border-border
                cursor-pointer
                transition-colors duration-120
                ${
                  active
                    ? 'bg-canvas text-ink'
                    : 'bg-surface text-ink-dim hover:bg-surface-hi'
                }
              `}
            >
              <span
                className={`
                  w-1 h-1 rounded-full flex-shrink-0
                  ${active ? 'bg-accent' : 'bg-muted'}
                `}
              />
              <span className="flex-1 min-w-0 text-[11px] truncate tabular-nums">
                {tab.title}
              </span>
              <button
                type="button"
                title="Close tab"
                onClick={e => {
                  e.stopPropagation()
                  void closeTab(tab.id)
                }}
                className="
                  opacity-0 group-hover:opacity-100
                  transition-opacity duration-120
                  w-4 h-4 flex items-center justify-center
                  text-muted hover:text-ink hover:bg-border
                  text-[14px] leading-none
                "
              >
                ×
              </button>
            </div>
          )
        })}

        {/* + button */}
        <button
          type="button"
          onClick={onNewTabRequest}
          title="New tab (⌘T)"
          className="
            flex items-center justify-center
            w-8 flex-shrink-0
            border-r border-border
            text-muted hover:text-ink hover:bg-surface-hi
            text-[14px] leading-none
            transition-colors duration-120
          "
        >
          +
        </button>
      </div>
    </div>
  )
}
