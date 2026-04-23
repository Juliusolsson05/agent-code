import { useEffect, useState } from 'react'

import type { TileNode } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// TabBar — one row of tab chrome at the top of the window. Each tab has
// a title, a close button, and activates on click. The `+` button opens
// the new-tab flow (pickDirectory → newTab).
//
// Traffic light inset: on macOS with `titleBarStyle: 'hiddenInset'`,
// the close/minimize/zoom buttons sit inside the content area. The
// old approach was a hardcoded `w-[70px]` spacer, which broke at
// non-default zoom levels and display scales. Now the main process
// pushes the actual right-edge X position of the traffic light
// buttons via IPC, and we use it as a dynamic width. Falls back to
// 70px if the IPC hasn't fired yet (first frame).

type Props = {
  workspace: Workspace
  onNewTabRequest: () => void
}

/** Collect every leaf session ID from a tile tree. */
function collectSessionIds(node: TileNode): string[] {
  if (node.type === 'leaf') return [node.sessionId]
  return [...collectSessionIds(node.a), ...collectSessionIds(node.b)]
}

export function TabBar({ workspace, onNewTabRequest }: Props) {
  const { state, runtimes, activateTab, closeTab } = workspace

  // Dynamic traffic light inset from main process. Updated on
  // resize / zoom / display change. 70 is the fallback for the
  // first frame before main pushes the value.
  const [trafficInset, setTrafficInset] = useState(70)
  useEffect(() => {
    return window.api.onTrafficLightInset(setTrafficInset)
  }, [])

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
      {/* Traffic-light padding on macOS. Width is pushed from the main
          process based on the actual button positions — zoom-safe and
          scale-safe. See pushTrafficLightInset() in main/index.ts. */}
      <div className="flex-shrink-0" style={{ width: trafficInset }} />

      {/* Tab list */}
      <div className="flex items-stretch flex-1 min-w-0 [-webkit-app-region:no-drag]">
        {state.tabs.map(tab => {
          const active = tab.id === state.activeTabId
          // Derive active/total pane counts from the tile tree +
          // runtimes. Pure derivation — no extra state needed.
          const sessionIds = collectSessionIds(tab.root)
          const total = sessionIds.length
          const alive = sessionIds.filter(id => {
            const rt = runtimes[id]
            return rt?.sessionStatus === 'running'
          }).length
          const allDone = alive === 0

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
              {/* Active/total pane badge — green when at least one
                  session is alive, red when all have exited. */}
              <span
                className={`
                  flex-shrink-0
                  text-[9px] font-code font-semibold tabular-nums
                  text-white
                  px-1.5 py-0.5 leading-none
                  ${allDone ? 'bg-red-500/80' : 'bg-green-500/80'}
                `}
              >
                {alive}/{total}
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
