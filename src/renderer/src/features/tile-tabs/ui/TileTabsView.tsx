import { Fragment, useEffect, useRef } from 'react'

import { TileTree } from '../../../tiles/TileTree'
import type { Workspace } from '../../../tiles/workspaceStore'

type Props = {
  workspace: Workspace
}

export function TileTabsView({ workspace }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{
    dividerIndex: number
    pointerId: number
  } | null>(null)

  const tileTabs = workspace.tileTabs
  if (!tileTabs) return null

  const tabs = tileTabs.tabIds
    .map(id => workspace.state.tabs.find(t => t.id === id) ?? null)
    .filter((tab): tab is NonNullable<typeof tab> => tab !== null)

  if (tabs.length < 2) return null

  const isVertical = tileTabs.direction === 'vertical'

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current
      const container = containerRef.current
      if (!drag || !container) return

      const rect = container.getBoundingClientRect()
      const total = isVertical ? rect.width : rect.height
      if (total <= 0) return

      const deltaPx = isVertical ? e.movementX : e.movementY
      const deltaRatio = deltaPx / total
      if (Math.abs(deltaRatio) < 0.0001) return
      workspace.resizeTiledTabByIndex(drag.dividerIndex, deltaRatio)
    }

    const onPointerUp = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== e.pointerId) return
      dragRef.current = null
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [isVertical, workspace])

  return (
    <div
      ref={containerRef}
      className={`h-full min-h-0 min-w-0 flex ${isVertical ? 'flex-row' : 'flex-col'} bg-canvas`}
    >
      {tabs.map((tab, index) => {
        const focused = tab.id === tileTabs.focusedTabId
        const ratio = tileTabs.ratios[index] ?? 1 / tabs.length
        return (
          <Fragment key={tab.id}>
            <div
              className="relative min-h-0 min-w-0 flex flex-col overflow-hidden"
              style={{ flex: `0 0 ${ratio * 100}%` }}
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
                  <div className="min-w-0 flex items-center gap-2">
                    <span className="inline-flex items-center justify-center w-5 h-5 text-[10px] border border-border text-muted flex-shrink-0">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="text-[12px] font-semibold text-ink truncate">
                        {tab.title}
                      </div>
                      <div className="text-[10px] uppercase tracking-wider text-muted">
                        Tiled Tab
                      </div>
                    </div>
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-muted flex-shrink-0">
                    {Math.round(ratio * 100)}%
                  </div>
                </div>
                <div className="relative flex-1 min-h-0 min-w-0 overflow-hidden">
                  <TileTree
                    tabId={tab.id}
                    node={tab.root}
                    focusedSessionId={focused ? tab.focusedSessionId : null}
                    workspace={workspace}
                  />
                </div>
              </section>
              {!focused && (
                <div className="absolute inset-0 pointer-events-none bg-canvas/34 ring-1 ring-inset ring-border" />
              )}
            </div>
            {index < tabs.length - 1 && (
              <div
                role="separator"
                aria-orientation={isVertical ? 'vertical' : 'horizontal'}
                className={`relative z-10 flex-shrink-0 touch-none before:content-[''] before:absolute before:bg-border/80 hover:before:bg-accent/70 before:transition-colors ${
                  isVertical
                    ? 'w-2 cursor-col-resize before:inset-y-0 before:left-1/2 before:-translate-x-1/2 before:w-px'
                    : 'h-2 cursor-row-resize before:inset-x-0 before:top-1/2 before:-translate-y-1/2 before:h-px'
                }`}
                onPointerDown={e => {
                  e.preventDefault()
                  dragRef.current = {
                    dividerIndex: index,
                    pointerId: e.pointerId,
                  }
                }}
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
