# Renderer: bound the feed-debug ring by bytes

Fixes #722. Refs #103, #375, #365.

## Problem

`SessionRuntime.feedDebugLog` is the per-session ring behind FeedDebugPanel.
It is capped at 500 entries but an entry can be a one-line summary or the
`visible_rows` record whose `data.rows` carries one object per feed item.
Over the 2026-09-01 → 09-03 run the `renderer.session.memory.feedDebugLog`
gauge peaked at 136,132,028 bytes for a single session — about five times
that session's live transcript window — and the ring is always on.

## Design

Mirror what #375 did for the live entry window: keep the count cap and add
a per-session byte budget. `appendFeedDebugLog` estimates each entry's JSON
size once (WeakMap-cached per entry object, like `estimateEntryBytes`),
sums the ring after the append, and evicts from the head until the ring is
under `FEED_DEBUG_LOG_MAX_BYTES` (4 MiB). The newest entry is never evicted
even if it alone exceeds the budget, so a single oversized record cannot
make the panel go blank.

Only the in-memory ring shrinks. Disk persistence (`useFeedDebugPersist` →
`main/storage/feedDebugLog.ts`) already ships entries by id cursor; as
before, an entry evicted before the one in-flight IPC append resolves is
not written, and the byte budget narrows that window for very large
records. That trade-off is the same one the count cap already makes and is
documented in the code.

Not in scope: shrinking the `visible_rows` payload itself (dropping `rows`
or windowing it) changes what debug bundles contain and is a separate
decision.

## Verification

- New `feedDebug.test.ts`: count cap keeps the newest 500 and monotonic ids;
  byte budget evicts oldest entries once the estimated total exceeds the
  budget; the newest entry survives even when oversized; small entries are
  never evicted by the byte rule.
- `npx tsc -p tsconfig.web.json --noEmit`.
- After: the `feedDebugLog` bytesEstimate gauge should stay ≤ ~4 MiB per
  session on the next long run.
