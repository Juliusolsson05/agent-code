import { describe, expect, it } from 'vitest'

import { indexEntryIntoMaps } from '@renderer/session-runtime/entries'
import {
  MAX_LIVE_ENTRIES,
  TRIM_TO_LIVE_ENTRIES,
  historyMarkerOf,
  planLiveEntryTrim,
  stampHistoryMarker,
} from '@renderer/session-runtime/liveEntryWindow'
import {
  emptySemanticRuntime,
  type SemanticRuntimeState,
} from '@renderer/session-runtime/state'
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

function windowEntry(i: number, opts: { uuid?: string | null; marker?: string | null } = {}): Entry {
  const uuid = opts.uuid === null ? undefined : opts.uuid ?? `u-${i}`
  const entry = {
    type: 'user',
    ...(uuid ? { uuid } : {}),
    parentUuid: null,
    timestamp: new Date(BASE_TS + i * 1000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text: `row ${i}` }] },
  } as unknown as Entry
  if (opts.marker !== null) stampHistoryMarker(entry, opts.marker ?? `m-${i}`)
  return entry
}

function windowEntries(count: number): Entry[] {
  return Array.from({ length: count }, (_, i) => windowEntry(i))
}

const emptyGhosts = new Map<string, GhostEntry>()

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
})
