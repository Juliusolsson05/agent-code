import { useLayoutEffect, useRef } from 'react'

import { useAgentTerminalOwnerVisible } from '@renderer/workspace/terminal/AgentTerminalOwnership'

import { slotRole, type SlotReport } from '../placement/resolvePlacement'
import { usePlacementStore } from '../placement/placementStore'
import { usePocketLive } from '../state/pocketLiveStore'

/**
 * An empty box that says where a pocket's page should appear. It NEVER
 * contains the page: moving a <webview> in the DOM destroys it (Electron's
 * web-view-element disconnectedCallback → detachGuest + reset), and lanes are
 * index-keyed, so a page inside a lane would reload on every lane insert,
 * reorder or Spotlight toggle. The page lives in BrowserPocketHost and follows
 * this box by CSS position (spec §5.3).
 */
export function PocketSlot(props: {
  pocketId: string
  surface: SlotReport['surface']
  laneIndex: number | null
  focused: boolean
  dimmed: boolean
  /** Rendered when this slot is visible but the page is shown elsewhere. */
  mirrorLabel?: (shownIn: SlotReport) => string
  children?: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Already composes every hidden context (stage behind Spotlight/Reader/
  // Settings, Global Editor), so a slot in the hidden stage reports invisible.
  const visible = useAgentTerminalOwnerVisible()
  const report = usePlacementStore(s => s.report)
  const remove = usePlacementStore(s => s.remove)
  const slots = usePlacementStore(s => s.slots[props.pocketId])
  const live = usePocketLive(props.pocketId)
  const slotKey = props.surface === 'spotlight' ? 'spotlight' : `lane:${props.laneIndex ?? 'x'}`

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const clipEl = el.closest('[data-pocket-clip]') as HTMLElement | null
    let frame = 0
    const publish = () => {
      frame = 0
      const r = el.getBoundingClientRect()
      const c = clipEl?.getBoundingClientRect()
      report(props.pocketId, {
        slotKey, surface: props.surface, laneIndex: props.laneIndex, focused: props.focused, visible, dimmed: props.dimmed,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        clip: c ? { x: c.left, y: c.top, width: c.width, height: c.height } : null,
      })
    }
    // Coalesce bursts (a lane-weight drag fires dozens of resizes per frame)
    // into one report per animation frame.
    const schedule = () => { if (!frame) frame = requestAnimationFrame(publish) }
    publish()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    // Position-only changes (a neighbouring lane resized) do not resize this
    // box, and ResizeObserver misses them (agent-orchestrator#5184); the clip
    // ancestor and the lane row do resize.
    if (clipEl) ro.observe(clipEl)
    if (clipEl?.parentElement) ro.observe(clipEl.parentElement)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      remove(props.pocketId, slotKey)
    }
  }, [props.pocketId, props.surface, props.laneIndex, props.focused, props.dimmed, visible, slotKey, report, remove])

  const role = slotRole(Object.values(slots ?? {}), slotKey)
  return (
    <div ref={ref} data-testid="pocket-slot" data-surface={props.surface} className="relative h-full w-full min-h-0 min-w-0 bg-canvas">
      {role.role === 'mirror' && (
        // A mirrored lane shows where the page is instead of starting a second
        // renderer process for the same pocket.
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 overflow-hidden text-[11px] text-ink-dim">
          {live.thumbnail && <img src={live.thumbnail} alt="" className="max-h-[70%] max-w-[90%] rounded-control opacity-60" />}
          <span>{props.mirrorLabel?.(role.shownIn) ?? 'Shown in another lane'}</span>
        </div>
      )}
      {props.children}
    </div>
  )
}
