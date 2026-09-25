import { create } from 'zustand'

import type { SlotReport } from './resolvePlacement'

// The placement layer's only state: who is asking to show which pocket where,
// and who needs a hidden pocket to keep painting. Keyed by pocketId — never
// SessionId (reloads mint new ones) and never lane index (spliced on every
// grid change). Renderer-only; nothing here is persisted.
//
// Page state (title, loading, driving…) lives in ../state/pocketLiveStore.ts
// and discovered ports in ../state/lanePortsStore.ts. Keeping them out of this
// store is what keeps placement reviewable on its own (decomposition §3).

type PlacementState = {
  slots: Record<string, Record<string, SlotReport>>
  /** Refcount of "must keep painting" leases (agent action, screenshot, picker). */
  paintLeases: Record<string, number>
  /** Last size the pocket was shown at, so parking does not reflow the page. */
  lastSize: Record<string, { width: number; height: number }>
  lastVisibleAt: Record<string, number>
  report: (pocketId: string, slot: SlotReport) => void
  remove: (pocketId: string, slotKey: string) => void
  acquirePaint: (pocketId: string) => () => void
  noteShown: (pocketId: string, size: { width: number; height: number }, at: number) => void
  forget: (pocketId: string) => void
}

export const usePlacementStore = create<PlacementState>(set => ({
  slots: {},
  paintLeases: {},
  lastSize: {},
  lastVisibleAt: {},
  report: (pocketId, slot) => set(s => {
    const prev = s.slots[pocketId]?.[slot.slotKey]
    // ResizeObserver and scroll fire far more often than anything changes;
    // an identical report must not re-render the host.
    if (prev && sameReport(prev, slot)) return s
    return { slots: { ...s.slots, [pocketId]: { ...s.slots[pocketId], [slot.slotKey]: slot } } }
  }),
  remove: (pocketId, slotKey) => set(s => {
    if (!s.slots[pocketId]?.[slotKey]) return s
    const { [slotKey]: _gone, ...rest } = s.slots[pocketId]!
    return { slots: { ...s.slots, [pocketId]: rest } }
  }),
  acquirePaint: pocketId => {
    set(s => ({ paintLeases: { ...s.paintLeases, [pocketId]: (s.paintLeases[pocketId] ?? 0) + 1 } }))
    let released = false
    return () => {
      if (released) return
      released = true
      set(s => ({ paintLeases: { ...s.paintLeases, [pocketId]: Math.max(0, (s.paintLeases[pocketId] ?? 1) - 1) } }))
    }
  },
  noteShown: (pocketId, size, at) => set(s => {
    const prev = s.lastSize[pocketId]
    const sameSize = prev && prev.width === size.width && prev.height === size.height
    // lastVisibleAt only needs second resolution for the 10-minute sleep rule.
    if (sameSize && at - (s.lastVisibleAt[pocketId] ?? 0) < 1000) return s
    return { lastSize: sameSize ? s.lastSize : { ...s.lastSize, [pocketId]: size }, lastVisibleAt: { ...s.lastVisibleAt, [pocketId]: at } }
  }),
  forget: pocketId => set(s => {
    const { [pocketId]: _a, ...slots } = s.slots
    const { [pocketId]: _b, ...paintLeases } = s.paintLeases
    const { [pocketId]: _c, ...lastSize } = s.lastSize
    const { [pocketId]: _d, ...lastVisibleAt } = s.lastVisibleAt
    return { slots, paintLeases, lastSize, lastVisibleAt }
  }),
}))

function sameReport(a: SlotReport, b: SlotReport): boolean {
  return a.surface === b.surface && a.laneIndex === b.laneIndex && a.focused === b.focused && a.visible === b.visible
    && a.dimmed === b.dimmed && sameRect(a.rect, b.rect) && sameRect(a.clip, b.clip)
}

function sameRect(a: SlotReport['rect'], b: SlotReport['rect']): boolean {
  if (a === b) return true
  if (!a || !b) return false
  // Sub-pixel jitter from fractional layout must not churn the host.
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
}
