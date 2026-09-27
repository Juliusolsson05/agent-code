import { describe, expect, it } from 'vitest'

import fixture from '../../../../testing/fixtures/ghosts/codex/message-item-identity.json'

import { ghostsFromSemanticTurn, reconcileUpstream } from '@renderer/session-runtime/ghosts'
import { mountCodexPane } from '@renderer/session-runtime/semantic/testing/proxyPaneDrivers'
import type { Frame } from '@renderer/session-runtime/semantic/testing/proxyPaneDrivers'
import { createCodexTranscriptEntryMapper } from '@providers/codex/renderer/transcript/mapper'

// #1231: a Codex text ghost is keyed by the proxy response id (`resp_…`), and
// the committed rollout entry never carried anything that equals it, so no
// Codex text ghost was ever superseded. Both sides do carry the provider ITEM
// id (`msg_…`): the proxy stream on output_item.added, the rollout on the
// response_item. The fixture is one real 0.157.1 assistant message seen from
// both sides (see its `evidence`). It drives the REAL codex proxy adapter and
// the REAL semantic fold, as the desktop hook does, then the REAL rollout
// mapper, through the same stateful wrapper all three production ingest
// surfaces use (review c: a bare mapper call would stay green if stamping
// moved into the wrapper).
const mapRollout = (record: unknown) =>
  createCodexTranscriptEntryMapper().map(record as Record<string, unknown>).entries

function ghostFromRecordedStream() {
  const pane = mountCodexPane()
  pane.request('req-1')
  pane.frames('req-1', fixture.sseFrames as Frame[])
  const turn = pane.reducer.pane.semantic.currentTurn
  if (!turn) throw new Error('recorded frames opened no semantic turn')
  const ghosts = ghostsFromSemanticTurn(turn, 'recorded-session', new Map())
  const textGhosts = [...ghosts.values()].filter(ghost =>
    Array.isArray(ghost.message.content) &&
    ghost.message.content.some(block => (block as { type?: string }).type === 'text'))
  return { turn, ghosts, textGhosts }
}

describe('Codex text ghosts are superseded by their committed rollout entry (#1231)', () => {
  it('supersedes the recorded message ghost when the rollout record for the same item lands', () => {
    const { turn, ghosts, textGhosts } = ghostFromRecordedStream()
    // The ghost is keyed by the response id; the rollout knows only the item.
    expect(turn.turnId).toBe((fixture.sseFrames[0] as { response: { id: string } }).response.id)
    expect(textGhosts).toHaveLength(1)

    const [entry] = mapRollout(fixture.rolloutRecord)
    expect(entry?.uuid).toBeTruthy()
    const next = reconcileUpstream(entry!, ghosts)
    expect(next.get(textGhosts[0]!.uuid)?._atp.supersededBy).toBe(entry!.uuid)
  })

  it('does not supersede it with a different message', () => {
    const { ghosts, textGhosts } = ghostFromRecordedStream()
    const other = structuredClone(fixture.rolloutRecord) as { payload: { id: string } }
    other.payload.id = other.payload.id.replace(/.$/, c => (c === '0' ? '1' : '0'))
    const [entry] = mapRollout(other)
    const next = reconcileUpstream(entry!, ghosts)
    expect(next.get(textGhosts[0]!.uuid)?._atp.supersededBy).toBeUndefined()
  })
})
