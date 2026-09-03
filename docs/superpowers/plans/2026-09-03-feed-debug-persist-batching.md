# Feed debug: batch persistence appends by time

Fixes #748. Refs #722, #103.

## Problem

`useFeedDebugPersist` runs in a `useEffect` keyed on the `runtimes` map,
which is replaced dozens of times per second while a turn streams. Every
replacement that finds new feed-debug entries sends them to main at once,
and the success path re-drains immediately, so the append cadence follows
the streaming cadence: 8,649–10,159 `debug:append-feed-log` invokes in a
77-minute run (20/s in bursts), each one a `writeFile(flag:'a')` plus a
retention-prune schedule on the main thread, with p95 352 ms and a 1.2 s
worst case on the Sep 1 run.

## Design

The hook keeps its two cursors (persisted / in-flight) and the one-append-
in-flight rule — those carry the retry and durability semantics — and only
changes WHEN a flush is started:

- A pure policy, `decideFeedDebugFlush`, answers "flush now", "arm a timer
  for N ms" or "nothing" from `{ pendingCount, lastFlushAt, now, inFlight }`.
  The first batch after a quiet period flushes immediately, so the entry
  that explains a bad paint is on disk within one IPC round trip. Anything
  that arrives within `FEED_DEBUG_FLUSH_INTERVAL_MS` (1.5 s) of the last
  flush waits for one per-session timer. `FEED_DEBUG_FLUSH_MAX_PENDING`
  (256 entries) forces an immediate flush so a burst cannot pile up an
  outsized batch behind the timer.
- On IPC success the hook no longer re-drains immediately; it re-runs the
  policy against the latest runtime, which arms the timer unless the
  threshold is crossed.
- Timers live in a ref keyed by session and are cleared on unmount only —
  the effect itself re-runs on every runtimes replacement and must not tear
  them down.

Trade-off accepted: up to 1.5 s of feed-debug entries can be lost on a hard
renderer crash. The ring's own durability note already accepts this; the
alternative (flush on `pagehide`) cannot await IPC and is not attempted.

Not in scope: the main-side append path (`feedDebugLog.ts`), the ring's
byte budget (#722), or the per-frame `runtimes` replacement itself, which
is a separate structural item.

## Verification

- `feedDebugFlushPolicy.test.ts`: immediate on first batch and after a
  quiet period; timer for the remainder of the interval inside it; forced
  flush at the pending threshold; nothing while an append is in flight.
- `useFeedDebugPersist.renderer.test.tsx` (fake timers, stubbed
  `window.api.appendFeedDebugLog`): rapid runtimes replacements produce one
  append immediately and one more after the interval carrying every entry
  that arrived in between; a failed append leaves the entries pending for
  the next flush; unmount clears the timer.
- `npx tsc -b`.
