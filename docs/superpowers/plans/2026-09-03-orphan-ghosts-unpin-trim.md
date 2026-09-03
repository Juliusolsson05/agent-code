# Renderer: stop hidden orphan ghosts from pinning the live-entry trim

Fixes #724. Refs #375, #103, #365.

## Problem

`computeProtectBound` lowers the live-entry trim bound to the `updatedAt` of
every un-superseded ghost, orphaned or not, and the 1 s sweep only ever
removes superseded ghosts. One orphaned ghost that JSONL never matches (every
sidecar-shaped stream, for instance) therefore pins the bound for the rest
of the session: `planLiveEntryTrim` returns `null` on every burst and
`runtime.entries` becomes append-only. The two-day journal shows the entry
window at 5,016 entries against a 2,000 cap (1,924 samples over the cap) and
one session holding 917 ghosts.

## Design

The render predicate (`rendering/model/ghostPredicate.ts` rule 4, mirrored in
`mergedEntries.ts`) already defines a ghost that can never paint again: it is
orphaned and its `updatedAt` is at or before `lastJsonlEntryAt`, which only
moves forward. The fix makes the two other consumers of the ghost map agree
with that definition instead of changing it:

1. `computeProtectBound` skips ghosts the predicate would hide under rule 4.
   `planLiveEntryTrim` takes `lastJsonlEntryAt` as a fourth argument (null
   keeps the current behaviour for callers and tests that do not have it).
2. The sweep gains `gcHiddenOrphanGhosts`: after a ghost has been orphaned
   for at least `GHOST_SUPERSEDED_GC_MS` and is at or before the JSONL tail,
   it is dropped from the map. The orphan transition already persisted it to
   the ghost log, so nothing durable is lost; on resume it is reloaded,
   hidden by the same rule, and swept again.

Nothing else moves: the orphan TTL, rules 1–5, `orphanStale`, and
`gcSupersededGhosts` are untouched, so which ghosts render is unchanged (see
the Warning section of `docs/design/ghost-system.md`). Orphans newer than
the JSONL tail — the "JSONL stuck" fallback the ghost system exists for —
still pin the bound and still stay in the map.

## Verification

- `entries.test.ts`: an orphaned ghost at or before `lastJsonlEntryAt` no
  longer bounds the trim; an orphaned ghost newer than the tail still does;
  a null tail keeps today's behaviour.
- New `ghosts.test.ts` for `gcHiddenOrphanGhosts`: evicts only orphaned,
  un-superseded ghosts at or before the tail once the grace has elapsed;
  keeps orphans newer than the tail, un-orphaned ghosts, and everything when
  the tail is null; reference-stable on no-op.
- `npx tsc -b --pretty false`.
- After: `renderer.session.memory.entries` should plateau at the cap and
  `ghostMap` should stop growing on the next long run.
