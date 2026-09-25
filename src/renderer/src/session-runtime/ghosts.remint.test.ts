import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GhostEntry } from 'agent-transcript-parser/ghost'

import {
  gcSupersededGhosts,
  ghostsFromSemanticTurn,
  reconcileUpstream,
  sweepGhosts,
} from '@renderer/session-runtime/ghosts'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'
import type { Entry } from '@shared/types/transcript'

// #730: a superseded ghost of the turn that is STILL current was evicted 5 s
// after supersedure, and the next semantic tick minted it again with no
// `supersededBy`. Its committed entry had already been reconciled, so nothing
// superseded it a second time: 30 s later it orphaned with an `updatedAt`
// newer than the JSONL tail, which is the one state the render predicate
// still paints (a duplicate of the committed tool call).
//
// The fixture is the real on-disk log of one such ghost (see its README):
// minted, superseded at +2.9 s, re-minted at +8.9 s, orphaned at +38.9 s.
// Across this machine's 1,955 logs the same sequence happened 3,231 times.

type Rec = GhostEntry & { _atp: GhostEntry['_atp'] & { supersededBy?: string } }
const records = readFileSync(
  join(import.meta.dirname, '../../../../testing/fixtures/ghost-remint/claude-tool-use-remint.ghost.jsonl'),
  'utf8',
).trim().split('\n').map(line => JSON.parse(line) as Rec)

const minted = records[0]!
const superseding = records.find(record => record._atp.supersededBy !== undefined)!
const reminted = records.find(record => record._atp.createdAt !== minted._atp.createdAt)!
const toolUse = (superseding.message.content as Array<{ id: string; name: string; input: unknown }>)[0]!

// The live turn exactly as the proxy described it when the ghost was minted:
// the Bash tool_use at blockIndex 2, input fully parsed, the tool running.
const liveTurn = {
  turnId: minted._atp.turnId,
  text: '',
  source: 'proxy',
  blocks: {
    [minted._atp.blockIndex]: {
      blockIndex: minted._atp.blockIndex,
      kind: 'tool_use',
      toolName: toolUse.name,
      toolUseId: toolUse.id,
      parsedInput: toolUse.input as Record<string, unknown>,
      finalized: true,
    },
  },
  blockOrder: [minted._atp.blockIndex],
  stopReason: null,
  usage: null,
  startedAt: minted._atp.createdAt,
  endedAt: null,
} as unknown as SemanticLiveTurn

// The committed JSONL entry that superseded it: Claude's assistant record
// carries the message id the ghost's turn id was minted from.
const committed = {
  type: 'assistant',
  uuid: superseding._atp.supersededBy,
  timestamp: new Date(superseding._atp.updatedAt).toISOString(),
  message: { id: minted._atp.turnId, role: 'assistant', content: [toolUse] },
} as unknown as Entry

const GC_MS = 5_000
const SESSION = minted.sessionId as string

afterEach(() => { vi.useRealTimers() })

function supersededGhostOfLiveTurn(): Map<string, GhostEntry> {
  vi.useFakeTimers({ now: minted._atp.createdAt })
  const live = ghostsFromSemanticTurn(liveTurn, SESSION, new Map())
  vi.setSystemTime(superseding._atp.updatedAt)
  const reconciled = reconcileUpstream(committed, live)
  expect(reconciled.get(minted.uuid)?._atp.supersededBy).toBe(superseding._atp.supersededBy)
  return reconciled
}

describe('a superseded ghost of the still-current turn (#730)', () => {
  it('is not evicted and re-minted un-superseded by the next semantic tick', () => {
    const reconciled = supersededGhostOfLiveTurn()

    // The recorded re-mint time: the sweep has run past the 5 s grace and
    // the semantic tick that follows sees the same current turn.
    const now = reminted._atp.createdAt
    vi.setSystemTime(now)
    const swept = gcSupersededGhosts(reconciled, now, GC_MS, liveTurn.turnId)
    const ticked = ghostsFromSemanticTurn(liveTurn, SESSION, swept)

    const ghost = ticked.get(minted.uuid)
    expect(ghost?._atp.supersededBy).toBe(superseding._atp.supersededBy)
    expect(ghost?._atp.createdAt).toBe(minted._atp.createdAt)
  })

  it('is evicted once its turn is no longer current, and is not minted again', () => {
    const reconciled = supersededGhostOfLiveTurn()
    const now = reminted._atp.createdAt
    vi.setSystemTime(now)

    // The next API request started a new turn. Only the new turn's blocks
    // are ever minted from here, so the old ghost can go.
    const nextTurn = { ...liveTurn, turnId: 'msg_next', blocks: {}, blockOrder: [] } as SemanticLiveTurn
    const swept = gcSupersededGhosts(reconciled, now, GC_MS, nextTurn.turnId)
    expect(swept.has(minted.uuid)).toBe(false)
    expect(ghostsFromSemanticTurn(nextTurn, SESSION, swept).has(minted.uuid)).toBe(false)
  })

  it('is evicted as before when no turn is current', () => {
    const reconciled = supersededGhostOfLiveTurn()
    const now = reminted._atp.createdAt
    expect(gcSupersededGhosts(reconciled, now, GC_MS, null).has(minted.uuid)).toBe(false)
  })

  // #1228 review: the fix is one argument at the call site, and the sweep
  // used to assemble its reducers inline where nothing tested them. These go
  // through the composed tick the 1 s timer runs, with the turn id read from
  // the runtime slice exactly as production passes it.
  it('survives the real sweep tick while its turn is current, and goes once it is not', () => {
    const reconciled = supersededGhostOfLiveTurn()
    const now = reminted._atp.createdAt
    vi.setSystemTime(now)
    const timing = { orphanTtlMs: 30_000, gcMs: GC_MS }
    const live = { ghosts: reconciled, lastJsonlEntryAt: superseding._atp.updatedAt, semantic: { currentTurn: liveTurn } }
    const swept = sweepGhosts(live, now, timing)
    expect(ghostsFromSemanticTurn(liveTurn, SESSION, swept).get(minted.uuid)?._atp.supersededBy)
      .toBe(superseding._atp.supersededBy)

    const idle = { ...live, ghosts: swept, semantic: { currentTurn: null } }
    expect(sweepGhosts(idle, now, timing).has(minted.uuid)).toBe(false)
  })

  it('stays frozen when its live block keeps streaming after supersedure', () => {
    // The supersede guard in ghostsFromSemanticTurn: a late delta for a block
    // whose committed record already landed must not rewrite the ghost or
    // bump its updatedAt (log noise, and a reset of its eviction clock).
    const reconciled = supersededGhostOfLiveTurn()
    const before = reconciled.get(minted.uuid)!
    vi.setSystemTime(reminted._atp.createdAt)
    const block = liveTurn.blocks[minted._atp.blockIndex]!
    const streamedOn = {
      ...liveTurn,
      blocks: { [minted._atp.blockIndex]: { ...block, parsedInput: { command: 'echo a later delta' } } },
    } as SemanticLiveTurn
    const ticked = ghostsFromSemanticTurn(streamedOn, SESSION, reconciled)
    expect(ticked.get(minted.uuid)).toBe(before)
  })
})
