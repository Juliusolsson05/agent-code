# Sub-agents: bound the parent-completion bookkeeping

Fixes #743. Refs #327, #365, #288, #103.

## Problem

`SubAgentWatcherManager` records every `tool_result` of the parent
transcript into a per-session map that is only consulted for the handful of
ids that belong to `Agent` sub-agent sidecars, and never trims it. Tens of
thousands of entries per long session, for the life of the session — the
#288 shape (retain everything, consume a sliver) in a sibling structure.

## Design

A small `CompletionLedger` per session replaces the raw map:

- `record(toolUseId, status)` puts a result into a bounded recent LRU
  (2,048 entries) — enough to cover the race where a result lands before
  its sidecar file is discovered, and to let every unrelated tool result
  age out.
- `lookup(toolUseId)` is what the watcher calls per emit. A hit in the
  recent window is promoted to a `claimed` map, which is bounded by the
  number of sub-agents the session ever had and is never evicted, so a
  finished sub-agent cannot flip back to "running" once its result has
  been seen — the watcher recomputes from `lookup` on every emit.
- `record` on an already-claimed id updates it in place (a re-emitted
  result with a different error flag still wins).

Observable behaviour (which sub-agents show done/error and when) is
unchanged for every sub-agent whose result is looked up within 2,048
subsequent tool results, which covers the sidecar poll interval by orders
of magnitude.

## Verification

- `completionLedger.test.ts`: recent window evicts oldest unclaimed ids at
  the cap; a claimed id survives any number of later records; lookup of an
  unknown id is undefined; record reports whether anything changed; an
  updated status on a claimed id is reflected.
- Existing `SubAgentWatcher` tests unchanged.
- `npx tsc -p tsconfig.node.json --noEmit`.
