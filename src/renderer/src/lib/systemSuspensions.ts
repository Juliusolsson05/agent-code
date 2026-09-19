import { useSyncExternalStore } from 'react'

import type { SystemSuspension } from '@shared/types/systemSuspension'

// The renderer's read-only view of when the machine was suspended (#963).
//
// Main owns detection (SystemSuspensionTracker); this module only mirrors it so
// the in-feed turn clock can subtract the night instead of counting it as
// Thinking time. It is deliberately a module-level store rather than workspace or
// session runtime state: a suspension belongs to the machine, not to a pane, and
// every visible counter in the window must subtract the same intervals.
//
// WHY it connects lazily on first subscriber: nothing needs it until a counter is
// on screen, and a window that mounts after the wake still reads the recent list
// once (the broadcast it missed) before listening for new suspensions.
//
// WHY `window.api` is guarded: renderer tests and any host without the preload
// bridge simply see no suspensions, which degrades to the old wall-clock counter
// rather than throwing inside a feed row.

const RETAIN = 200

let snapshot: readonly SystemSuspension[] = []
let connected = false
const listeners = new Set<() => void>()

function merge(incoming: readonly SystemSuspension[]): void {
  if (incoming.length === 0) return
  const byKey = new Map(snapshot.map(suspension => [`${suspension.suspendedAt}:${suspension.resumedAt}`, suspension]))
  for (const suspension of incoming) {
    byKey.set(`${suspension.suspendedAt}:${suspension.resumedAt}`, suspension)
  }
  const next = [...byKey.values()]
    .sort((a, b) => a.suspendedAt - b.suspendedAt)
    .slice(-RETAIN)
  // Keep the reference when nothing changed, so every subscribed counter does
  // not re-render for a duplicate (the initial read and the broadcast can both
  // carry the same suspension).
  if (next.length === snapshot.length && next.every((suspension, index) => suspension === snapshot[index])) return
  snapshot = next
  for (const listener of listeners) listener()
}

function connect(): void {
  if (connected) return
  connected = true
  const api = typeof window === 'undefined' ? undefined : window.api
  if (typeof api?.listSystemSuspensions !== 'function' || typeof api.onSystemSuspension !== 'function') return
  api.onSystemSuspension(suspension => merge([suspension]))
  void api.listSystemSuspensions().then(merge).catch(() => {})
}

function subscribe(listener: () => void): () => void {
  connect()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): readonly SystemSuspension[] {
  return snapshot
}

/** The machine's recent suspensions, oldest first. */
export function useSystemSuspensions(): readonly SystemSuspension[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Test seam: module state must not leak between tests. */
export function __resetSystemSuspensionsForTests(): void {
  snapshot = []
  connected = false
  listeners.clear()
}
