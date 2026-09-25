import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'
import { useShallow } from 'zustand/react/shallow'

import { resolveTabSessions } from '@renderer/workspace/queries'
import { useCommandChordLabel, withChord } from '@renderer/features/command-keybindings/useCommandChord'
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

export function TabBar({ workspace, onNewTabRequest }: Props) {
  const { state, activateTab, closeTab } = workspace
  const newTabChord = useCommandChordLabel('new-tab')
  const closeTabChord = useCommandChordLabel('close-tab')
  // KEYBOARD (plan N1): the strip is a WAI-ARIA tablist with roving focus,
  // like the editor's tabs. One Tab stop (the active tab); ←/→ and Home/End
  // move AND activate (switching project is instant and reversible — the
  // APG "automatic activation" case); Delete closes the focused tab. Before,
  // each tab was a `div onClick` with no role and no tabIndex: the only
  // keyboard route was ⌘[ / ⌘] / ⌘⇧W, and nothing announced the tabs.
  const tabRefs = useRef(new Map<string, HTMLDivElement>())
  const onTabListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const tabs = state.tabs
    if (tabs.length === 0) return
    const index = Math.max(0, tabs.findIndex(tab => tab.id === state.activeTabId))
    if (event.key === 'Delete') {
      event.preventDefault()
      const tab = tabs[index]
      if (tab) void closeTab(tab.id)
      return
    }
    const next =
      event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home' ? 0
            : event.key === 'End' ? tabs.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    const tab = tabs[next]!
    activateTab(tab.id)
    tabRefs.current.get(tab.id)?.focus()
  }
  // Only the running flags affect tab counts. Text, spinner, draft and debug
  // mutations must not render all tab buttons merely because their map changed.
  const runningIds = useAppStore(useShallow(store => Object.keys(store.workspaceRuntimes)
    .filter(id => store.workspaceRuntimes[id]?.sessionStatus === 'running')))
  const running = useMemo(() => new Set(runningIds), [runningIds])

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
        bg-tab-bg border-b border-panel-border
        flex-shrink-0
        select-none
        [-webkit-app-region:drag]
      "
    >
      {/* Traffic-light padding on macOS. Width is pushed from the main
          process based on the actual button positions — zoom-safe and
          scale-safe. See pushTrafficLightInset() in main/index.ts. */}
      <div className="flex-shrink-0" style={{ width: trafficInset }} />

      {/* Tab list.
          WHY no-drag lives on each INTERACTIVE CHILD, not this container:
          this container is flex-1 — it spans every pixel right of the
          traffic lights. With no-drag up here, the empty bar right of the
          "+" button (usually most of the row) was dead: not a tab, not a
          button, and not draggable either. Combined with the traffic-light
          spacer collapsing to 0 after a renderer reload (inset arrives via
          IPC), the window could end up with NO draggable header at all —
          "I can't move the app" (post-#517 investigation). Drag is
          inherited from the bar; each tab/button opts out individually,
          which is exactly the Chrome tab-strip behavior users expect. */}
      <div className="flex items-stretch flex-1 min-w-0">
        <div className="flex items-stretch min-w-0" role="tablist" aria-label="Project tabs" onKeyDown={onTabListKeyDown}>
        {state.tabs.map(tab => {
          const active = tab.id === state.activeTabId
          // Derive active/total pane counts from the tile tree +
          // runtimes. Pure derivation — no extra state needed.
          const sessionIds = resolveTabSessions(state, tab.id)
          const total = sessionIds.length
          const alive = sessionIds.filter(id => running.has(id)).length
          const allDone = alive === 0

          return (
            <div
              key={tab.id}
              ref={element => {
                if (element) tabRefs.current.set(tab.id, element)
                else tabRefs.current.delete(tab.id)
              }}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => activateTab(tab.id)}
              onKeyDown={event => {
                // A div, so Enter/Space are not native activation here.
                if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                  event.preventDefault()
                  activateTab(tab.id)
                }
              }}
              className={`
                outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring
                group
                flex items-center gap-2
                px-3 py-2
                min-w-[120px] max-w-[220px]
                border-r border-panel-border
                cursor-pointer
                [-webkit-app-region:no-drag]
                transition-colors duration-120
                ${
                  active
                    ? 'bg-tab-active-bg text-ink'
                    : 'bg-tab-bg text-ink-dim hover:bg-tab-hover-bg'
                }
              `}
            >
              <span
                className={`
                  w-1 h-1 rounded-full flex-shrink-0
                  ${active ? 'bg-tab-accent' : 'bg-muted'}
                `}
              />
              <span className="flex-1 min-w-0 text-[11px] truncate tabular-nums">
                {tab.title}
              </span>
              {/* Active/total pane badge — green when at least one
                  session is alive, red when all have exited. */}
              <span
                className={`
                  flex-shrink-0 rounded-chip
                  text-[10px] font-code font-semibold tabular-nums
                  px-1.5 py-0.5 leading-none
                  ${allDone ? 'bg-danger text-danger-fg' : 'bg-success text-success-fg'}
                `}
              >
                {alive}/{total}
              </span>
              {/* Mouse affordance; the keyboard closes with Delete on the
                  focused tab, so this stays out of the Tab order (a second
                  stop per tab would double the strip's stops). Revealed on
                  keyboard focus too (it appeared on hover only), and named
                  for its tab. */}
              <button
                type="button"
                tabIndex={-1}
                title={withChord('Close Tab', closeTabChord)}
                aria-label={`Close ${tab.title}`}
                onClick={e => {
                  e.stopPropagation()
                  void closeTab(tab.id)
                }}
                className="
                  opacity-0 group-hover:opacity-100 group-focus-within:opacity-100
                  transition-opacity duration-120
                  w-4 h-4 flex items-center justify-center rounded-control
                  text-muted hover:text-ink hover:bg-border
                  text-[14px] leading-none
                "
              >
                ×
              </button>
            </div>
          )
        })}
        </div>

        {/* + button */}
        <button
          type="button"
          onClick={onNewTabRequest}
          // Live chord (plan H4): a literal "(⌘T)" outlived any rebind.
          title={withChord('New Tab', newTabChord)}
          aria-label="New Tab"
          className="
            flex items-center justify-center
            w-8 flex-shrink-0
            border-r border-border
            text-muted hover:text-ink hover:bg-control-hover-bg
            text-[14px] leading-none
            transition-colors duration-120
            outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring
            [-webkit-app-region:no-drag]
          "
        >
          +
        </button>
      </div>
    </div>
  )
}
