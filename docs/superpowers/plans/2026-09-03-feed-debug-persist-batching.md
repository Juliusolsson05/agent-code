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
  for N ms" or "nothing" from `{ pendingCount, pendingBytes, lastAttemptAt,
  now, inFlight }`. The first batch after a quiet period flushes
  immediately, so the entry that explains a bad paint is on disk within one
  IPC round trip. Anything that arrives within `FEED_DEBUG_FLUSH_INTERVAL_MS`
  (1.5 s) of the last attempt waits for one per-session timer.
  `FEED_DEBUG_FLUSH_MAX_PENDING` (256 entries) or
  `FEED_DEBUG_FLUSH_MAX_PENDING_BYTES` (1 MiB, from the ring's cached per-
  entry estimate) forces an immediate flush: the ring is byte-capped at
  4 MiB and evicts from the head, and with the #722 shape (hundreds of KB
  per entry) twenty entries already exceed it, so a count ceiling alone
  would let unpersisted entries be evicted while waiting.
- On IPC success or failure the hook re-runs the policy, which arms the
  timer unless a ceiling is crossed; a failed attempt counts as an attempt
  so a rejecting main does not turn streaming into a retry storm.
- A session that leaves `runtimes` (replacement, pane close, tab kill,
  reload) gets one final, unpaced flush of its trailing entries from the
  last runtime snapshot — parked until an in-flight append resolves if
  there is one — then its bookkeeping is dropped. Those entries (exit code,
  kill reason) are the ones debug bundles read for closed panes.
- Timers live in a ref keyed by session and are cleared on unmount only —
  the effect itself re-runs on every runtimes replacement and must not tear
  them down.

Trade-off accepted: up to 1.5 s of feed-debug entries can be lost when the
renderer goes away without unmounting cleanly (hard crash) or at window
close (an `invoke` cannot be awaited past teardown). The ring's own
durability note already accepts this.

Not in scope: the main-side append path (`feedDebugLog.ts`) and the
per-frame `runtimes` replacement itself, which is a separate structural
item. Two pre-existing durability bugs found in review are tracked
separately: #770 (soft reload restarts ids below the persisted cursor) and
#771 (the fail-closed stat path resolves instead of rejecting).

## Verification

- `feedDebugFlushPolicy.test.ts`: immediate on first batch and after a
  quiet period; timer for the remainder of the interval inside it; forced
  flush at the count ceiling and at the byte ceiling; nothing while an
  append is in flight.
- `useFeedDebugPersist.renderer.test.tsx` (fake timers, stubbed
  `window.api.appendFeedDebugLog`): rapid runtimes replacements produce one
  append immediately and one more after the interval carrying every entry
  that arrived in between; entries arriving while an append is in flight
  are paced on resolve, not drained; the byte ceiling forces a flush; a
  failed append leaves the entries pending and retries after the interval;
  a removed session's trailing entries are flushed at once, or once its
  in-flight append resolves; unmount clears the timer.
- `npx tsc -b`.
