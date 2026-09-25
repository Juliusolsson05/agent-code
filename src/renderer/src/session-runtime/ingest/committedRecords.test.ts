import { describe, expect, it } from 'vitest'

import type { Entry, ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { historyMarkerOf } from '@renderer/session-runtime/liveEntryWindow'
import {
  admitMappedEntries,
  reindexToolsAfterMerge,
  type CommittedSeenLedger,
} from './committedRecords'
import type { HistoryPlacement } from './historyPlacement'

// The admission rules every ingest site now shares (#1177). What this suite
// owns is the one contract that differs by MODE — the #375 part B asymmetry
// that keeps a trimmed row from reappearing at the tail while letting the
// older-history pager bring it back — plus the history reindex that decides
// which block a repeated tool id resolves to. Those are the two rules the
// copies had drifted on, so they are the ones worth pinning here.

const entry = (uuid: string, content: unknown[] = [{ type: 'text', text: uuid }]): Entry =>
  ({ uuid, type: 'assistant', message: { role: 'assistant', content } }) as unknown as Entry

function ledger(seen: string[], trimmed: string[] = []): CommittedSeenLedger & { trimmed: Set<string> } {
  const tomb = new Set(trimmed)
  return {
    seen: new Set(seen),
    trimmed: tomb,
    isTrimmed: uuid => tomb.has(uuid),
    releaseTrimmed: uuid => { tomb.delete(uuid) },
  }
}

describe('admitMappedEntries', () => {
  it('never re-admits a trimmed row at the tail, live or initial', () => {
    // A resume replay (live) or a bootstrap chunk (tail) carrying an id the
    // window trimmed must not append it below newer rows.
    for (const mode of ['live', 'tail'] as const) {
      const l = ledger(['kept'], ['trimmed'])
      const placement: HistoryPlacement[] = []
      const { admitted } = admitMappedEntries([entry('trimmed'), entry('kept'), entry('new')], 'm', mode, l, { placement })
      expect(admitted.map(e => e.uuid)).toEqual(['new'])
      // Already-held and trimmed ids are anchors for placement, never rows.
      expect(placement).toEqual([{ anchor: 'trimmed' }, { anchor: 'kept' }, { fresh: admitted[0] }])
      expect(l.trimmed.has('trimmed')).toBe(true)
    }
  })

  it('lets only an older page bring a trimmed row back, and retires its tombstone', () => {
    const l = ledger(['trimmed', 'kept'], ['trimmed'])
    const { admitted } = admitMappedEntries([entry('trimmed'), entry('kept')], 'm-old', 'older', l)
    expect(admitted.map(e => e.uuid)).toEqual(['trimmed'])
    expect(l.trimmed.has('trimmed')).toBe(false)
    // The reloaded row carries its line's marker again, so a later trim can
    // re-anchor pagination at it.
    expect(historyMarkerOf(admitted[0]!)).toBe('m-old')
  })
})

describe('reindexToolsAfterMerge', () => {
  const use = (id: string, input: string): ToolUseBlock => ({ type: 'tool_use', id, name: 'Read', input: { path: input } }) as ToolUseBlock
  const result = (id: string, text: string): ToolResultBlock => ({ type: 'tool_result', tool_use_id: id, content: text }) as ToolResultBlock

  it('keeps the newest block when a history batch repeats a live tool id', () => {
    // The window already holds the live pairing; an older page re-delivers
    // the same id with an earlier body. Indexing the page after the live
    // rows (the desktop's pre-#1177 pager) made the OLD body win.
    const live = entry('live', [use('t1', 'new-path'), result('t1', 'new output')])
    const older = entry('older', [use('t1', 'old-path'), result('t1', 'old output')])
    const toolUseIndex = new Map<string, ToolUseBlock>([['t1', use('t1', 'new-path')]])
    const toolResultIndex = new Map<string, ToolResultBlock>([['t1', result('t1', 'new output')]])
    const changed = reindexToolsAfterMerge([older], [older, live], { toolUseIndex, toolResultIndex })
    expect(changed).toBe(true)
    expect((toolUseIndex.get('t1')!.input as { path: string }).path).toBe('new-path')
    expect(toolResultIndex.get('t1')!.content).toBe('new output')
  })

  it('leaves the maps and the version alone for a batch with no tool block', () => {
    const toolUseIndex = new Map<string, ToolUseBlock>([['t1', use('t1', 'p')]])
    const toolResultIndex = new Map<string, ToolResultBlock>()
    const before = toolUseIndex.get('t1')
    expect(reindexToolsAfterMerge([entry('prose')], [entry('prose')], { toolUseIndex, toolResultIndex })).toBe(false)
    expect(toolUseIndex.get('t1')).toBe(before)
  })
})
