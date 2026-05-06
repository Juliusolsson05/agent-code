import assert from 'node:assert/strict'

import {
  createGhost,
  orphanGhost,
  supersedeGhost,
  type ClaudeEntry,
} from 'agent-transcript-parser/ghost'

import { orphanStale } from '../src/renderer/src/workspace/ghosts'
import { selectMergedEntries } from '../src/renderer/src/workspace/mergedEntries'
import { emptyRuntime } from '../src/renderer/src/workspace/workspaceState'

function baseEntry(uuid: string): ClaudeEntry {
  return {
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: 'session-1',
    timestamp: '2026-04-24T00:00:00.000Z',
    message: {
      id: `msg-${uuid}`,
      role: 'assistant',
      content: [{ type: 'text', text: `committed ${uuid}` }],
    },
  } as ClaudeEntry
}

function textGhost(turnId: string, text: string) {
  return createGhost({
    sessionId: 'session-1',
    turnId,
    blockIndex: 0,
    role: 'assistant',
    content: [{ type: 'text', text }],
  })
}

{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries)
}

{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  const ghost = textGhost('turn-a', 'not ready yet')
  runtime.ghosts = new Map([[ghost.uuid, ghost]])

  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries)
}

{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  const ghost = orphanGhost(textGhost('turn-a', 'jsonl never wrote'), 2000)
  runtime.ghosts = new Map([[ghost.uuid, ghost]])

  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged.length, 2)
  assert.equal(merged[1]?.uuid, ghost.uuid)
}

{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  const ghost = orphanGhost(textGhost('turn-a', 'current live turn'), 2000)
  runtime.ghosts = new Map([[ghost.uuid, ghost]])

  const merged = selectMergedEntries(runtime, 'turn-a')
  assert.equal(merged, runtime.entries)
}

{
  const runtime = emptyRuntime()
  runtime.entries = [baseEntry('real-1')]
  const ghost = orphanGhost(
    supersedeGhost(textGhost('turn-a', 'already committed'), 'real-1', 2000),
    3000,
  )
  runtime.ghosts = new Map([[ghost.uuid, ghost]])

  const merged = selectMergedEntries(runtime, null)
  assert.equal(merged, runtime.entries)
}

{
  const fresh = textGhost('turn-a', 'fresh')
  const freshMap = new Map([[fresh.uuid, fresh]])
  assert.equal(orphanStale(freshMap, fresh._atp.updatedAt + 500, 1000), freshMap)

  const staleMap = orphanStale(freshMap, fresh._atp.updatedAt + 2000, 1000)
  assert.notEqual(staleMap, freshMap)
  assert.ok(staleMap.get(fresh.uuid)?._atp.orphanedAt !== undefined)
}

console.log('ghost fallback tests passed')
