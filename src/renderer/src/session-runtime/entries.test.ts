import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { indexEntryIntoMaps } from '@renderer/session-runtime/entries'
import {
  MAX_LIVE_ENTRIES,
  MAX_LIVE_ENTRY_BYTES,
  TRIM_TO_LIVE_ENTRIES,
  TRIM_TO_LIVE_ENTRY_BYTES,
  estimateLiveEntriesBytes,
  historyMarkerOf,
  planLiveEntryTrim,
  stampHistoryMarker,
} from '@renderer/session-runtime/liveEntryWindow'
import { emptySemanticRuntime } from '@renderer/session-runtime/state'
import type { SemanticRuntimeState } from '@renderer/session-runtime/state'
import type { GhostEntry } from 'agent-transcript-parser/ghost'
import type {
  Entry,
  ToolResultBlock,
  ToolUseBlock,
} from '@shared/types/transcript'

function assistantWithToolUse(uuid: string, toolUseId: string): Entry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'git status' } },
      ],
    },
  } as Entry
}

function userWithToolResult(uuid: string, toolUseId: string, text: string): Entry {
  return {
    type: 'user',
    uuid,
    parentUuid: null,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }],
    },
  } as Entry
}

describe('indexEntryIntoMaps', () => {
  it('reports a change when a new tool_use is inserted', () => {
    const useIndex = new Map<string, ToolUseBlock>()
    const resultIndex = new Map<string, ToolResultBlock>()
    expect(
      indexEntryIntoMaps(assistantWithToolUse('a', 'tu-1'), useIndex, resultIndex),
    ).toBe(true)
    expect(useIndex.has('tu-1')).toBe(true)
  })

  it('reports a change when a tool_result lands in a later entry (the cross-entry case)', () => {
    const useIndex = new Map<string, ToolUseBlock>()
    const resultIndex = new Map<string, ToolResultBlock>()
    indexEntryIntoMaps(assistantWithToolUse('a', 'tu-1'), useIndex, resultIndex)
    // A separate, later entry carries the paired result. This is exactly the
    // case that left a mounted GitCardRow stale before the version token.
    expect(
      indexEntryIntoMaps(userWithToolResult('b', 'tu-1', 'clean'), useIndex, resultIndex),
    ).toBe(true)
    expect(resultIndex.get('tu-1')?.content).toBe('clean')
  })

  it('reports NO change when the identical block reference is re-indexed', () => {
    const useIndex = new Map<string, ToolUseBlock>()
    const resultIndex = new Map<string, ToolResultBlock>()
    const entry = assistantWithToolUse('a', 'tu-1')
    expect(indexEntryIntoMaps(entry, useIndex, resultIndex)).toBe(true)
    // Re-ingesting the SAME entry object (duplicate burst replay) must not bump
    // the version — otherwise bootstrap re-delivery would invalidate context.
    expect(indexEntryIntoMaps(entry, useIndex, resultIndex)).toBe(false)
  })

  it('reports NO change for an entry with no tool blocks', () => {
    const useIndex = new Map<string, ToolUseBlock>()
    const resultIndex = new Map<string, ToolResultBlock>()
    const textOnly = {
      type: 'assistant',
      uuid: 'a',
      parentUuid: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    } as Entry
    expect(indexEntryIntoMaps(textOnly, useIndex, resultIndex)).toBe(false)
  })

  it('reports a change when an existing key is re-pointed to a different block', () => {
    const useIndex = new Map<string, ToolUseBlock>()
    const resultIndex = new Map<string, ToolResultBlock>()
    indexEntryIntoMaps(userWithToolResult('b', 'tu-1', 'running'), useIndex, resultIndex)
    // Same tool_use_id, fresh block object with updated content → must report a
    // change so the row repaints with the final output.
    expect(
      indexEntryIntoMaps(userWithToolResult('c', 'tu-1', 'done'), useIndex, resultIndex),
    ).toBe(true)
    expect(resultIndex.get('tu-1')?.content).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// Live entry window (#375 part B) — the pure trim planner + marker rider.
// The React-integration half (the burst handler applying a plan) is covered
// in useIpcSubscriptions.renderer.test.tsx.
// ---------------------------------------------------------------------------

const BASE_TS = Date.parse('2026-07-09T10:00:00.000Z')

function windowEntry(
  i: number,
  opts: { uuid?: string | null; marker?: string | null; blocks?: unknown[] } = {},
): Entry {
  const uuid = opts.uuid === null ? undefined : opts.uuid ?? `u-${i}`
  const entry = {
    type: 'user',
    ...(uuid ? { uuid } : {}),
    parentUuid: null,
    timestamp: new Date(BASE_TS + i * 1000).toISOString(),
    message: {
      role: 'user',
      content: opts.blocks ?? [{ type: 'text', text: `row ${i}` }],
    },
  } as unknown as Entry
  if (opts.marker !== null) stampHistoryMarker(entry, opts.marker ?? `m-${i}`)
  return entry
}

function windowEntries(count: number): Entry[] {
  return Array.from({ length: count }, (_, i) => windowEntry(i))
}

const emptyGhosts = new Map<string, GhostEntry>()

function orphanGhostAt(updatedAt: number): GhostEntry {
  return {
    uuid: `g-orphan-${updatedAt}`,
    type: 'assistant',
    _atp: { updatedAt, orphanedAt: updatedAt },
  } as unknown as GhostEntry
}

function ghostAt(updatedAt: number, superseded = false): GhostEntry {
  return {
    uuid: `g-${updatedAt}`,
    type: 'assistant',
    _atp: {
      updatedAt,
      ...(superseded ? { supersededBy: 'real-uuid' } : {}),
    },
  } as unknown as GhostEntry
}

function semanticWithHistoryStart(startedAt: number): SemanticRuntimeState {
  const semantic = emptySemanticRuntime()
  return {
    ...semantic,
    history: [
      {
        turnId: 't-1',
        text: '',
        source: null,
        blocks: {},
        blockOrder: [],
        stopReason: null,
        usage: null,
        task: { todos: [], doneCount: 0, totalCount: 0, inProgressToolUseIds: [], activeToolNames: [] },
        lookups: { toolCallsById: {}, toolUseIdsInOrder: [], resolvedToolUseIds: [], erroredToolUseIds: [] },
        startedAt,
        endedAt: startedAt + 1000,
      },
    ],
  }
}

describe('stampHistoryMarker', () => {
  it('is invisible to JSON.stringify (debug bundles must not grow markers)', () => {
    const entry = windowEntry(0)
    expect(historyMarkerOf(entry)).toBe('m-0')
    expect(JSON.stringify(entry)).not.toContain('m-0')
  })
})

describe('planLiveEntryTrim', () => {
  it('returns null at or below MAX_LIVE_ENTRIES', () => {
    expect(
      planLiveEntryTrim(windowEntries(MAX_LIVE_ENTRIES), emptySemanticRuntime(), emptyGhosts),
    ).toBeNull()
  })

  it('trims down to TRIM_TO_LIVE_ENTRIES and re-anchors pagination at the oldest retained marker', () => {
    const entries = windowEntries(MAX_LIVE_ENTRIES + 100)
    const plan = planLiveEntryTrim(entries, emptySemanticRuntime(), emptyGhosts)
    expect(plan).not.toBeNull()
    expect(plan!.cut).toBe(entries.length - TRIM_TO_LIVE_ENTRIES)
    expect(plan!.trimmedUuids).toHaveLength(plan!.cut)
    expect(plan!.trimmedUuids[0]).toBe('u-0')
    // The new historyOldestMarker is the FIRST RETAINED entry's marker, so
    // loadOlderHistory ("strictly before marker") re-fetches the trimmed span.
    expect(plan!.nextOldestMarker).toBe(`m-${plan!.cut}`)
  })

  it('reclaims a recorded queued-command attachment like any other durable entry', () => {
    const bundle = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          'testing/fixtures/rendering-bundles/2026-06-14T14-25-07-012-a8ad1ebb.json',
        ),
        'utf8',
      ),
    ) as { input: { entries: Array<Record<string, unknown>> } }
    const durable = bundle.input.entries[13] as unknown as Entry
    stampHistoryMarker(durable, 'recorded-queued-command-marker')
    const entries = [durable, ...windowEntries(MAX_LIVE_ENTRIES + 99)]

    const plan = planLiveEntryTrim(entries, emptySemanticRuntime(), emptyGhosts)
    expect(plan).not.toBeNull()
    expect(plan!.trimmedUuids).toContain(durable.uuid)
    // The UUID is provider-durable, not an optimistic prefix, so this row can
    // leave the heap and later return through ordinary older-history paging.
    expect(plan!.trimmedUuids[0]).toBe(durable.uuid)
  })

  it('freezes the window when any entry lacks a uuid (ingest-index id + reload-dedupe safety)', () => {
    const entries = windowEntries(MAX_LIVE_ENTRIES + 100)
    // A retained uuid-less entry would be re-keyed `entry:ingest-${index}`
    // after the shift — the phantom-duplicate class committed.ts guards.
    entries[MAX_LIVE_ENTRIES] = windowEntry(MAX_LIVE_ENTRIES, { uuid: null })
    expect(planLiveEntryTrim(entries, emptySemanticRuntime(), emptyGhosts)).toBeNull()
  })

  it('never trims past the oldest semantic-history turn startedAt (committed-ownership safety)', () => {
    const entries = windowEntries(MAX_LIVE_ENTRIES + 100)
    // History turn started at the wall-clock of entry 40 — entries 40+ are
    // potential committed owners of that turn's blocks and must stay.
    const semantic = semanticWithHistoryStart(BASE_TS + 40 * 1000)
    const plan = planLiveEntryTrim(entries, semantic, emptyGhosts)
    expect(plan).not.toBeNull()
    expect(plan!.cut).toBe(40)
    expect(plan!.nextOldestMarker).toBe('m-40')
  })

  it('never trims past an un-superseded ghost updatedAt, but ignores superseded ghosts', () => {
    const entries = windowEntries(MAX_LIVE_ENTRIES + 100)
    const ghosts = new Map<string, GhostEntry>([
      ['g-live', ghostAt(BASE_TS + 25 * 1000)],
      // Superseded — its committed owner is durable, safe to trim past.
      ['g-done', ghostAt(BASE_TS + 5 * 1000, true)],
    ])
    const plan = planLiveEntryTrim(entries, emptySemanticRuntime(), ghosts)
    expect(plan).not.toBeNull()
    expect(plan!.cut).toBe(25)
  })

  // #724: the render predicate's rule 4 hides an orphaned ghost for good once
  // the committed JSONL tail is at-or-past its updatedAt. Such a ghost has no
  // committed owner that trimming could orphan on screen, so it must not pin
  // the bound — one never-matched orphan used to freeze the window forever.
  it('ignores an orphaned ghost the JSONL tail has already passed', () => {
    const entries = windowEntries(MAX_LIVE_ENTRIES + 100)
    const ghosts = new Map<string, GhostEntry>([
      ['g-hidden', orphanGhostAt(BASE_TS + 25 * 1000)],
    ])
    const plan = planLiveEntryTrim(entries, emptySemanticRuntime(), ghosts, BASE_TS + 30 * 1000)
    expect(plan).not.toBeNull()
    expect(plan!.cut).toBe(entries.length - TRIM_TO_LIVE_ENTRIES)
  })

  it('still protects an orphaned ghost newer than the JSONL tail (stuck-JSONL fallback)', () => {
    const entries = windowEntries(MAX_LIVE_ENTRIES + 100)
    const ghosts = new Map<string, GhostEntry>([
      ['g-ahead', orphanGhostAt(BASE_TS + 25 * 1000)],
    ])
    const plan = planLiveEntryTrim(entries, emptySemanticRuntime(), ghosts, BASE_TS + 20 * 1000)
    expect(plan).not.toBeNull()
    expect(plan!.cut).toBe(25)
  })

  it('keeps every un-superseded ghost protective while no JSONL tail is known', () => {
    const entries = windowEntries(MAX_LIVE_ENTRIES + 100)
    const ghosts = new Map<string, GhostEntry>([
      ['g-orphan', orphanGhostAt(BASE_TS + 25 * 1000)],
    ])
    const plan = planLiveEntryTrim(entries, emptySemanticRuntime(), ghosts, null)
    expect(plan).not.toBeNull()
    expect(plan!.cut).toBe(25)
  })

  it('stops at an optimistic row', () => {
    const entries = windowEntries(MAX_LIVE_ENTRIES + 100)
    entries[10] = windowEntry(10, { uuid: 'optimistic-codex-user:123' })
    const plan = planLiveEntryTrim(entries, emptySemanticRuntime(), emptyGhosts)
    expect(plan).not.toBeNull()
    expect(plan!.cut).toBe(10)
  })

  it('aborts when no retained entry can supply a pagination marker', () => {
    const entries = Array.from({ length: MAX_LIVE_ENTRIES + 100 }, (_, i) =>
      windowEntry(i, { marker: null }),
    )
    // Trimming without advancing historyOldestMarker would strand the
    // trimmed region — unreachable by pagination forever.
    expect(planLiveEntryTrim(entries, emptySemanticRuntime(), emptyGhosts)).toBeNull()
  })

  // ---- Constraint 5: pair integrity (#511 review blocker 1) ----
  // The ingest path rebuilds toolUseIndex/toolResultIndex from RETAINED
  // entries only after a trim, so a boundary that separates a cross-entry
  // pair (tool_use trimmed, tool_result retained) would permanently strip
  // the retained result row of its source-tool metadata.

  it('pulls the boundary older instead of splitting a cross-entry tool pair', () => {
    const entries = windowEntries(MAX_LIVE_ENTRIES + 100)
    const cut = entries.length - TRIM_TO_LIVE_ENTRIES
    // tool_use in the last would-be-trimmed entry, its result in the first
    // retained one — the exact adjacent assistant/user split every provider
    // produces, landing exactly on the hysteresis boundary.
    entries[cut - 1] = windowEntry(cut - 1, {
      blocks: [{ type: 'tool_use', id: 'tu-split', name: 'Read', input: { file_path: '/x' } }],
    })
    entries[cut] = windowEntry(cut, {
      blocks: [{ type: 'tool_result', tool_use_id: 'tu-split', content: 'file body' }],
    })
    const plan = planLiveEntryTrim(entries, emptySemanticRuntime(), emptyGhosts)
    expect(plan).not.toBeNull()
    // Boundary retreats to RETAIN the tool_use entry (never trims the
    // result instead — it might sit inside the protected region).
    expect(plan!.cut).toBe(cut - 1)
    expect(plan!.trimmedUuids).toHaveLength(cut - 1)
    expect(plan!.nextOldestMarker).toBe(`m-${cut - 1}`)
  })

  it('resolves chained pair references to a fixpoint', () => {
    const entries = windowEntries(MAX_LIVE_ENTRIES + 100)
    const cut = entries.length - TRIM_TO_LIVE_ENTRIES
    // Retaining the result at cut+10 forces entry 500 (its use) to stay;
    // entry 500 ALSO carries a result whose use lives at 400 — retention
    // must chase the chain, not stop after one hop.
    entries[400] = windowEntry(400, {
      blocks: [{ type: 'tool_use', id: 'tu-a', name: 'Bash', input: { command: 'ls' } }],
    })
    entries[500] = windowEntry(500, {
      blocks: [
        { type: 'tool_result', tool_use_id: 'tu-a', content: 'a done' },
        { type: 'tool_use', id: 'tu-b', name: 'Bash', input: { command: 'pwd' } },
      ],
    })
    entries[cut + 10] = windowEntry(cut + 10, {
      blocks: [{ type: 'tool_result', tool_use_id: 'tu-b', content: 'b done' }],
    })
    const plan = planLiveEntryTrim(entries, emptySemanticRuntime(), emptyGhosts)
    expect(plan).not.toBeNull()
    expect(plan!.cut).toBe(400)
    expect(plan!.trimmedUuids).toHaveLength(400)
    expect(plan!.nextOldestMarker).toBe('m-400')
  })

  it('leaves the boundary alone for pairs that are entirely trimmed or entirely retained', () => {
    const entries = windowEntries(MAX_LIVE_ENTRIES + 100)
    const cut = entries.length - TRIM_TO_LIVE_ENTRIES
    // Fully trimmed pair — both sides leave the window together.
    entries[10] = windowEntry(10, {
      blocks: [{ type: 'tool_use', id: 'tu-old', name: 'Bash', input: {} }],
    })
    entries[11] = windowEntry(11, {
      blocks: [{ type: 'tool_result', tool_use_id: 'tu-old', content: 'ok' }],
    })
    // Fully retained pair — never enters the trimmed-use index at all.
    entries[cut + 1] = windowEntry(cut + 1, {
      blocks: [{ type: 'tool_use', id: 'tu-new', name: 'Bash', input: {} }],
    })
    entries[cut + 2] = windowEntry(cut + 2, {
      blocks: [{ type: 'tool_result', tool_use_id: 'tu-new', content: 'ok' }],
    })
    const plan = planLiveEntryTrim(entries, emptySemanticRuntime(), emptyGhosts)
    expect(plan).not.toBeNull()
    expect(plan!.cut).toBe(cut)
  })

  // ---- Byte budget (#511 review blocker 2) ----
  // #375 is a bytes problem: a few hundred entries dragging huge
  // tool_results must trigger the window long before the count cap.

  it('trims on the byte budget even when the entry count is far under MAX_LIVE_ENTRIES', () => {
    const big = 'x'.repeat(100_000)
    const entries = Array.from({ length: 400 }, (_, i) =>
      windowEntry(i, { blocks: [{ type: 'text', text: big }] }),
    )
    expect(entries.length).toBeLessThan(MAX_LIVE_ENTRIES)
    expect(estimateLiveEntriesBytes(entries)).toBeGreaterThan(MAX_LIVE_ENTRY_BYTES)
    const plan = planLiveEntryTrim(entries, emptySemanticRuntime(), emptyGhosts)
    expect(plan).not.toBeNull()
    expect(plan!.cut).toBeGreaterThan(0)
    // Hysteresis: retained estimate lands at/under the byte target (no
    // safety constraint is active here to stop the walk early).
    expect(plan!.retainedBytesEstimate).toBeLessThanOrEqual(TRIM_TO_LIVE_ENTRY_BYTES)
    // The plan's estimates and the shared estimator agree exactly — both
    // read the same per-entry cache.
    expect(estimateLiveEntriesBytes(entries.slice(plan!.cut))).toBe(plan!.retainedBytesEstimate)
    expect(plan!.preTrimBytesEstimate).toBe(estimateLiveEntriesBytes(entries))
  })

  it('byte trims stop at the protection bound rather than reaching the byte target', () => {
    const big = 'x'.repeat(100_000)
    const entries = Array.from({ length: 400 }, (_, i) =>
      windowEntry(i, { blocks: [{ type: 'text', text: big }] }),
    )
    // Live turn started at entry 20's wall clock — everything from there on
    // is protected, so only 20 entries are trimmable even though the byte
    // target would ask for far more. Trim what's allowed and stop.
    const semantic = semanticWithHistoryStart(BASE_TS + 20 * 1000)
    const plan = planLiveEntryTrim(entries, semantic, emptyGhosts)
    expect(plan).not.toBeNull()
    expect(plan!.cut).toBe(20)
    expect(plan!.retainedBytesEstimate).toBeGreaterThan(TRIM_TO_LIVE_ENTRY_BYTES)
  })
})
