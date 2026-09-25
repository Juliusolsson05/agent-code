import { describe, expect, it } from 'vitest'

import { collectCommittedCandidates } from '@renderer/rendering/observations/committed'
import { collectOptimisticCandidates } from '@renderer/rendering/observations/local'
import {
  OPTIMISTIC_TWIN_CLOCK_TOLERANCE_MS,
  buildCommittedOwnership,
  decideLiveCandidate,
} from '@renderer/rendering/model/ownership'
import pastedTypedPrompt from '../../../../../testing/fixtures/prompt-acceptance/pasted-typed-prompt-2026-09-20.json'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'

// #1181: an optimistic prompt row is owned only by a committed user row with
// the same text that is NOT OLDER than the submit.
//
// The failure this pins: ownership used to be text presence alone, so the
// second `continue` of a session was "owned" by the first one from an hour
// earlier and was rejected the moment it was minted. The prompt left the
// composer at Enter and appeared nowhere until the transcript caught up.
// Driven through the real collectors so the timestamps are the ones production
// derives (entry.timestamp for committed rows, submit time for optimistic).

const T = 1_700_000_000_000
const iso = (ms: number) => new Date(ms).toISOString()

function decide(committedAtMs: number | null, submittedAtMs: number | null) {
  const committed = collectCommittedCandidates(
    [{
      uuid: 'c1',
      type: 'user',
      ...(committedAtMs === null ? {} : { timestamp: iso(committedAtMs) }),
      message: { role: 'user', content: 'continue' },
    }],
    'claude',
    's1',
  )
  const [optimistic] = collectOptimisticCandidates(
    [{ uuid: 'optimistic-codex-user:sub-1', text: 'continue', submittedAtMs }],
    'claude',
    's1',
  )
  return decideLiveCandidate(
    optimistic!,
    buildCommittedOwnership(committed.candidates),
    getRendererProviderCapabilities('claude').ledgerPolicy.suppression,
  )
}

describe('optimistic prompt ownership by a committed twin', () => {
  it('an older committed prompt with the same text does not own a new submit', () => {
    expect(decide(T - 60 * 60_000, T)).toMatchObject({ selected: true })
  })

  it('the committed row of THIS submit owns it (the normal handoff)', () => {
    expect(decide(T + 350, T)).toMatchObject({
      selected: false,
      reason: 'optimistic-owned-by-committed',
    })
  })

  it('absorbs small skew between the renderer clock and the provider clock', () => {
    expect(decide(T - OPTIMISTIC_TWIN_CLOCK_TOLERANCE_MS + 1, T)).toMatchObject({ selected: false })
    expect(decide(T - OPTIMISTIC_TWIN_CLOCK_TOLERANCE_MS - 1, T)).toMatchObject({ selected: true })
  })

  it('keeps the presence rule when either side has no timestamp', () => {
    // A missing time proves nothing, so the old conservative behavior stands.
    expect(decide(null, T)).toMatchObject({ selected: false })
    expect(decide(T - 60 * 60_000, null)).toMatchObject({ selected: false })
  })

  it('a pasted Claude prompt is owned through its <pasted_content> envelope', () => {
    // Claude commits a pasted prompt inside its own envelope while the pending
    // row carries the typed text. Without unwrapping, both rows painted until
    // the send settled (PR #1183 review). The committed row is the real
    // recording, not a hand-written shape: the collector keys typed-prompt
    // recognition on fields (permissionMode) an invented row would omit.
    const entry = pastedTypedPrompt.transcriptEntry
    const committedAtMs = Date.parse(entry.timestamp)
    const typed = entry.message.content
      .replace(/^<pasted_content id="cade">\n/, '')
      .replace(/\n<\/pasted_content id="cade">$/, '')
    const committed = collectCommittedCandidates([entry], 'claude', 's1')
    expect(committed.candidates).toHaveLength(1)
    const [optimistic] = collectOptimisticCandidates(
      [{ uuid: 'optimistic-codex-user:sub-2', text: typed, submittedAtMs: committedAtMs - 300 }],
      'claude',
      's1',
    )
    expect(decideLiveCandidate(
      optimistic!,
      buildCommittedOwnership(committed.candidates),
      getRendererProviderCapabilities('claude').ledgerPolicy.suppression,
    )).toMatchObject({ selected: false, reason: 'optimistic-owned-by-committed' })
  })
})
