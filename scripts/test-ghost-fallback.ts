import assert from 'node:assert/strict'

import {
  createGhost,
  orphanGhost,
  supersedeGhost,
  type ClaudeContentBlock,
  type ClaudeEntry,
} from 'agent-transcript-parser/ghost'

import { orphanStale } from '../src/renderer/src/workspace/ghosts'
import { selectMergedEntries } from '../src/renderer/src/workspace/mergedEntries'
import { emptyRuntime } from '../src/renderer/src/workspace/workspaceState'

// Wall-clock anchor for tests. Concrete values keep the predicate
// inputs explicit and avoid Date.now() drift between assertions.
const T_OLD_JSONL = 1_700_000_000_000
const T_GHOST_NEWER = T_OLD_JSONL + 5_000
const T_GHOST_OLDER = T_OLD_JSONL - 5_000

function baseEntry(uuid: string, timestamp = '2026-04-24T00:00:00.000Z'): ClaudeEntry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: 'session-1',
    timestamp,
    message: {
      id: `msg-${uuid}`,
      role: 'assistant',
      content: [{ type: 'text', text: `committed ${uuid}` }],
    },
  } as ClaudeEntry
}

function ghostWithContent(
  turnId: string,
  content: ClaudeContentBlock[],
  now: number,
) {
  return createGhost({
    sessionId: 'session-1',
    turnId,
    blockIndex: 0,
    role: 'assistant',
    content,
    now,
  })
}

function shortTextGhost(turnId: string, text: string, now: number) {
  return ghostWithContent(turnId, [{ type: 'text', text }], now)
}

function longTextGhost(turnId: string, now: number) {
  // 250 chars — past the SIDECAR_GHOST_TEXT_MAX threshold (200), so
  // the sidecar shape filter will let it through.
  const text = 'A real assistant turn that streamed enough text that it could not be a one-line title-gen sidecar leak. The shape filter is a 200-char cap; this string deliberately blows past that to verify the structural rule applies.'
  return ghostWithContent(turnId, [{ type: 'text', text }], now)
}

function toolUseGhost(turnId: string, now: number) {
  // Tool_use ghosts are explicitly NOT sidecar-shaped (the shape
  // filter only matches single-text-block assistant ghosts), so a
  // tool_use orphan past lastJsonlEntryAt should render even if
  // short.
  return ghostWithContent(
    turnId,
    [
      {
        type: 'tool_use',
        id: `tool-${turnId}`,
        name: 'Read',
        input: { file_path: '/tmp/example.ts' },
      },
    ],
    now,
  )
}

// ---------------------------------------------------------------------------
// 1. Empty ghost map → return entries by identity (reference-stable
//    short-circuit; Feed memos rely on this).
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries)
}

// ---------------------------------------------------------------------------
// 2. Ghost not yet orphaned → hidden (JSONL might still arrive
//    within TTL; SemanticStreamingTurn covers the live current
//    turn, this ghost shouldn't double-render).
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = longTextGhost('turn-a', T_GHOST_NEWER)
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries, 'unorphaned ghost must not render')
}

// ---------------------------------------------------------------------------
// 3. Superseded ghost → hidden (JSONL caught up; reconcileUpstream
//    has the row already).
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    supersedeGhost(longTextGhost('turn-a', T_GHOST_NEWER), 'real-1', T_GHOST_NEWER + 1),
    T_GHOST_NEWER + 2,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries, 'superseded ghost must not render')
}

// ---------------------------------------------------------------------------
// 4. Orphan ghost for the live current turn → hidden.
//    SemanticStreamingTurn owns the live turn render; surfacing a
//    ghost for the same turn would double-render.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    longTextGhost('turn-a', T_GHOST_NEWER),
    T_GHOST_NEWER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, 'turn-a')
  assert.equal(merged, runtime.entries, 'current-turn ghost must not render')
}

// ---------------------------------------------------------------------------
// 5. Orphan ghost for a semantic-history turn → hidden.
//    Completed semantic history is still rendered by
//    SemanticStreamingTurn while JSONL catches up. A ghost for the
//    same turn is not fallback data; it is the same assistant/tool
//    content trying to tail-append itself again after the orphan TTL.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  runtime.semantic.history = [{ turnId: 'turn-a' }] as typeof runtime.semantic.history
  const ghost = orphanGhost(
    longTextGhost('turn-a', T_GHOST_NEWER),
    T_GHOST_NEWER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries, 'semantic-history ghost must not render')
}

// ---------------------------------------------------------------------------
// 6. Orphan ghost OLDER than lastJsonlEntryAt → hidden. This is the
//    "stale orphan from earlier in the session, JSONL kept writing
//    past it" case: a sidecar leak that happened before later real
//    JSONL entries. Predicate-4 catches it structurally.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    longTextGhost('turn-a', T_GHOST_OLDER),
    T_GHOST_OLDER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries, 'orphan older than JSONL tail must not render')
}

// ---------------------------------------------------------------------------
// 7. Orphan ghost NEWER than lastJsonlEntryAt with sidecar shape
//    (single short text block, ≤200 chars) → hidden. This is the
//    tail-sidecar case the timestamp predicate alone cannot
//    catch: predict-next-prompt fires after the last real JSONL
//    entry, no later real turn supersedes it. Shape filter is the
//    backstop.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    shortTextGhost('turn-a', 'short ack', T_GHOST_NEWER),
    T_GHOST_NEWER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries, 'sidecar-shaped tail orphan must not render')
}

// ---------------------------------------------------------------------------
// 8. Orphan ghost NEWER than lastJsonlEntryAt with substantive text
//    (>200 chars) → renders. This is the main case ghost was built
//    for: JSONL stopped writing while proxy kept going for an
//    in-flight assistant turn.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    longTextGhost('turn-a', T_GHOST_NEWER),
    T_GHOST_NEWER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged.length, 2, 'substantive orphan past JSONL tail must render')
  assert.equal(merged[1]?.uuid, ghost.uuid)
}

// ---------------------------------------------------------------------------
// 9. Orphan tool_use ghost NEWER than lastJsonlEntryAt → renders
//    even though short. tool_use is structurally not a sidecar
//    shape — Claude Code's auxiliary calls all return text-only
//    bodies, never tool_use blocks.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = T_OLD_JSONL
  const ghost = orphanGhost(
    toolUseGhost('turn-a', T_GHOST_NEWER),
    T_GHOST_NEWER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged.length, 2, 'tool_use orphan past JSONL tail must render')
  assert.equal(merged[1]?.uuid, ghost.uuid)
}

// ---------------------------------------------------------------------------
// 10. lastJsonlEntryAt === null (fresh session, no JSONL ever) AND
//    orphan ghost present → render decision falls through the
//    timestamp gate (rule 4 only fires when lastJsonlEntryAt is
//    non-null). The shape filter still applies, so the ghost
//    renders only if it's not sidecar-shaped.
// ---------------------------------------------------------------------------
{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  runtime.lastJsonlEntryAt = null
  const ghost = orphanGhost(
    longTextGhost('turn-a', T_GHOST_NEWER),
    T_GHOST_NEWER + 1,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged.length, 2, 'orphan with null lastJsonlEntryAt must render if shape passes')
  assert.equal(merged[1]?.uuid, ghost.uuid)
}

// ---------------------------------------------------------------------------
// 11. orphanStale TTL behavior. Confirms the helper still produces
//     reference-stable no-ops and that an orphan flag is set when
//     the threshold elapses.
// ---------------------------------------------------------------------------
{
  const fresh = shortTextGhost('turn-a', 'fresh', T_OLD_JSONL)
  const freshMap = new Map([[fresh.uuid, fresh]])
  assert.equal(orphanStale(freshMap, fresh._atp.updatedAt + 500, 1000), freshMap)

  const staleMap = orphanStale(freshMap, fresh._atp.updatedAt + 2000, 1000)
  assert.notEqual(staleMap, freshMap)
  assert.ok(staleMap.get(fresh.uuid)?._atp.orphanedAt !== undefined)
}

console.log('ghost render predicate tests passed')
