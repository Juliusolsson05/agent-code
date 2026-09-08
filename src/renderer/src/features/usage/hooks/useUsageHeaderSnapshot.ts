import { useEffect, useState } from 'react'

import type { UsageSnapshot } from '@preload/index'

/** 60s, not 30s: quota percentages move on multi-minute timescales, and
 *  the main-process cache TTL is 30s (usageService.ts) — polling faster
 *  than the TTL just returns cached snapshots half the time. 60s halves
 *  IPC chatter for zero perceptible staleness, and the shared cache means
 *  header + modal can never stampede the provider APIs (worst case one
 *  real upstream fetch per 30s regardless of consumer count). */
const POLL_INTERVAL_MS = 60_000

/** Polls the usage snapshot for the header widget.
 *
 *  Component-local state, not a store slice: the widget is the only
 *  consumer, and SettingsBar unmounts it when usageHeaderEnabled is off,
 *  which tears down the interval — the disabled feature costs zero.
 *  Promote to zustand only if a second consumer ever appears.
 *
 *  Visibility-gated: this repo has been burned by background polling
 *  before (proxy-events full-file 200ms poll OOM, 2026-07-07; 60Hz
 *  screen-snapshot GC churn). Ambient chrome must not tick in a hidden
 *  window — ticks while hidden are skipped, and re-focus triggers an
 *  immediate refresh so the user never reads a minutes-old number.
 *
 *  `enabled` exists because mount-gating stopped being sufficient the
 *  moment a SECOND consumer appeared. The bulk provider-switch modal is
 *  registered as a permanent surface (app/surfaces/registry.tsx) and is
 *  rendered with `open={false}` for the life of the app — calling this
 *  hook there unconditionally would have run the mount fetch, the 60 s
 *  interval and the visibilitychange listener forever, for a modal
 *  nobody had opened and even with the usage header switched off.
 *  Passing `open` restores the "the disabled feature costs zero"
 *  contract for callers that cannot express it by unmounting. Default
 *  true so the header indicator keeps its mount-gated behavior
 *  unchanged. */
export function useUsageHeaderSnapshot(
  enabled = true,
): { snapshot: UsageSnapshot | null; stale: boolean } {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [stale, setStale] = useState(false)

  useEffect(() => {
    // Nothing is scheduled and nothing is fetched while disabled: the effect
    // returns before the first poll, so there is no interval and no listener
    // to tear down. The last good snapshot is deliberately KEPT in state —
    // reopening the modal should paint the number it last knew rather than
    // flash empty while the first poll lands.
    if (!enabled) return

    let disposed = false
    let inFlight = false

    const poll = async () => {
      // In-flight guard: a hung IPC round-trip must not queue a second
      // one behind it (the proxy-events OOM was exactly an unguarded
      // overlapping poll).
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const next = await window.api.getUsageSnapshot({})
        if (!disposed) {
          setSnapshot(next)
          setStale(false)
        }
      } catch {
        // Keep the last good snapshot on failure — never blank working
        // chrome because one poll failed. The widget renders it with a
        // "(stale — ...)" tooltip note instead.
        if (!disposed) setStale(true)
      } finally {
        inFlight = false
      }
    }

    void poll()
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])

  return { snapshot, stale }
}
