import { describe, expect, it, vi, afterEach } from 'vitest'

import type { AgentProviderKind } from '@shared/types/providerKind'
import type { RenderCandidate, RenderLedger, RenderRow, OwnershipDecision } from '@renderer/rendering/model/types'
import type { RuntimeLedgerSlices } from '@renderer/rendering/adapter/collectLedgerInput'
import {
  parseRecording,
  replayRecording,
  type RecordingHeader,
  type RecordedLine,
  type ReplayItemsProjection,
  type ReplayResult,
  type ReplayTick,
} from '@renderer/rendering/replay/recordedSession'
import {
  ledgerFeedContextFromRuntime,
  ledgerToFeedItems,
} from '@renderer/features/feed/ledger/ledgerFeedItems'

// The REAL feed-owned view bridge, injected through the harness's
// projectItems seam (#493 PR-3): the harness itself may not import
// features/, but this test's whole point is exercising the full stack —
// including the #239 dropped-candidate accounting — so it supplies the
// production bridge.
const projectItems: ReplayItemsProjection = (ledger, view, provider) =>
  ledgerToFeedItems(ledger, ledgerFeedContextFromRuntime(view, provider))
import { assertInvariants } from '@renderer/rendering/replay/invariants'

// ---------------------------------------------------------------------------
// Slice 5 — invariant replay. Two halves:
//   1. GREEN: a realistic recording (prompt → streamed tool → committed handoff
//      → completion → exit) must produce ZERO invariant violations. This proves
//      the harness's own output is invariant-clean over real transitions,
//      including a genuine explained vanish (the tool row handed to a committed
//      row) and D11 no-op ticks.
//   2. NEGATIVE CONTROLS: hand-crafted ReplayResults that INJECT each defect,
//      proving every invariant actually fires (a green test that can never go
//      red is worthless). One control per invariant.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number): string => new Date(ms).toISOString()

const HEADER: RecordingHeader = {
  v: 1,
  recordingId: 'rec-invariants',
  sessionId: 's1',
  provider: 'claude',
  providerSessionId: 'psid-1',
  cwd: '/work',
  appVersion: '0.0.0',
  startedAtWall: T,
}

function ev(t: number, ch: string, payload: unknown): RecordedLine {
  return { t, wall: T + t, ch, payload } as RecordedLine
}

function realisticRecording(): RecordedLine[] {
  return [
    ev(0, 'session:started', { sessionId: 's1', kind: 'claude' }),
    ev(10, 'session:jsonl-entries', {
      sessionId: 's1',
      entries: [
        {
          entry: {
            uuid: 'u1',
            type: 'user',
            timestamp: iso(T),
            sessionId: 'psid-1',
            message: { role: 'user', content: 'do the thing' },
          },
          file: 'transcript.jsonl',
        },
      ],
    }),
    ev(20, 'session:semantic-event', { sessionId: 's1', event: { type: 'turn_started', turnId: 'turn_live', source: 'proxy' } }),
    ev(30, 'session:semantic-event', { sessionId: 's1', event: { type: 'block_started', turnId: 'turn_live', blockIndex: 0, kind: 'text', source: 'proxy' } }),
    ev(40, 'session:semantic-event', { sessionId: 's1', event: { type: 'text_delta', turnId: 'turn_live', blockIndex: 0, textDelta: 'Hello, working.' } }),
    ev(45, 'session:semantic-event', {
      sessionId: 's1',
      event: { type: 'block_started', turnId: 'turn_live', blockIndex: 1, kind: 'tool_use', toolName: 'Bash', toolUseId: 'toolu_1', source: 'proxy' },
    }),
    ev(50, 'session:process-state', { sessionId: 's1', active: true, status: 'running Bash' }),
    ev(55, 'session:jsonl-entries', {
      sessionId: 's1',
      entries: [
        {
          entry: {
            uuid: 'a1',
            type: 'assistant',
            timestamp: iso(T + 1000),
            sessionId: 'psid-1',
            message: {
              role: 'assistant',
              id: 'msg_a1',
              content: [
                { type: 'text', text: 'Hello, working.' },
                { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
              ],
            },
          },
          file: 'transcript.jsonl',
        },
      ],
    }),
    ev(60, 'session:semantic-event', { sessionId: 's1', event: { type: 'usage_updated', turnId: 'turn_live' } }),
    ev(70, 'session:semantic-event', { sessionId: 's1', event: { type: 'turn_completed', turnId: 'turn_live' } }),
    ev(80, 'session:exit', { sessionId: 's1', exitCode: 0 }),
  ]
}

afterEach(() => {
  vi.useRealTimers()
})

// --- fabrication helpers for the negative controls --------------------------

function mkCandidate(partial: Partial<RenderCandidate> & { id: string }): RenderCandidate {
  return {
    owner: 'ledger',
    provider: 'claude',
    sourcePlane: 'committed',
    sessionId: 's1',
    contentKind: 'assistant-text',
    timestampMs: T,
    sequence: 0,
    ...partial,
  } as RenderCandidate
}

function mkRow(partial: Partial<RenderCandidate> & { id: string }): RenderRow {
  return {
    candidate: mkCandidate(partial),
    order: { sequence: 0, timeMs: T, source: 'ledger' },
  }
}

function mkLedger(rows: RenderRow[], decisions: OwnershipDecision[] = []): RenderLedger {
  return { rows, decisions, unknowns: [] }
}

const EMPTY_SLICES: RuntimeLedgerSlices = {
  provider: 'claude' as AgentProviderKind,
  sessionId: 's1',
  entries: [],
  semanticCurrent: null,
  semanticHistory: [],
  ghosts: new Map(),
  streamPhase: 'idle',
  lastJsonlEntryAtMs: null,
}

/** Fresh, distinct slices object — the realistic default, since two ticks with
 *  different rows necessarily had different inputs. The D11 controls override
 *  this with a SHARED reference to assert the identical-inputs contract. */
function freshSlices(): RuntimeLedgerSlices {
  return { ...EMPTY_SLICES, entries: [] }
}

function mkTick(index: number, ledger: RenderLedger, slices: RuntimeLedgerSlices = freshSlices()): ReplayTick {
  return {
    index,
    line: { t: index, wall: T + index, ch: 'session:semantic-event', payload: {} },
    slices,
    ledger,
    rows: ledger.rows,
    feedItems: [],
    dropped: [],
    // Finding #27: ReplayTick now carries the adapter's collection-time
    // rejections so the vanish invariant can explain a row killed before it
    // became a ledger candidate. The negative controls fabricate ledgers
    // directly and exercise no collection stage, so this is empty here.
    collectorDecisions: [],
  }
}

function resultOf(ticks: ReplayTick[]): ReplayResult {
  return { header: HEADER, ticks }
}

// ---------------------------------------------------------------------------

describe('invariant replay — green over a realistic recording', () => {
  it('finds no violations across a prompt → tool → completion → exit stream', () => {
    vi.useFakeTimers()
    const recording = parseRecording({ header: HEADER, events: realisticRecording() })
    const replay = replayRecording(recording, { onBeforeFold: w => vi.setSystemTime(w), projectItems })

    // Sanity: the stream actually exercised the transitions we care about —
    // otherwise "no violations" is vacuous.
    const sawToolHandoff = replay.ticks.some(t =>
      t.ledger.decisions.some(d => d.candidateId === 'sem:turn_live:1' && d.reason === 'committed-tool-use-owned'),
    )
    expect(sawToolHandoff).toBe(true)

    expect(assertInvariants(replay)).toEqual([])
  })
})

describe('invariant replay — negative controls (each invariant must fire)', () => {
  it('detects a dual-render (two selected rows own the same toolUseId)', () => {
    // Two selected rows both claim toolu_X — the "tool card painted twice" bug.
    const ledger = mkLedger([
      mkRow({ id: 'sem:turn_a:1', sourcePlane: 'semantic', turnId: 'turn_a', blockIndex: 1, toolUseId: 'toolu_X', contentKind: 'tool-use' }),
      mkRow({ id: 'entry:e1', ownedToolUseIds: ['toolu_X'] }),
    ])
    const violations = assertInvariants(resultOf([mkTick(0, ledger)]))
    expect(violations.map(v => v.kind)).toContain('dual-render')
    expect(violations.find(v => v.kind === 'dual-render')?.message).toMatch(/toolu_X/)
  })

  it('detects a vanish-without-replacement (row gone, no decision, turn still live)', () => {
    // A committed row present at tick 0, absent at tick 1, with NO rejection
    // decision and no artifact cover — the #469 silent-vanish class.
    const t0 = mkTick(0, mkLedger([mkRow({ id: 'entry:e1', sourcePlane: 'committed' })]))
    const t1 = mkTick(1, mkLedger([])) // e1 gone, decisions empty → unexplained
    const violations = assertInvariants(resultOf([t0, t1]))
    expect(violations.map(v => v.kind)).toContain('vanish-without-replacement')
    // A net shrink with an unexplained drop is ALSO reported (invariant 3).
    expect(violations.map(v => v.kind)).toContain('unexplained-shrink')
  })

  it('does NOT flag a vanish that carries a rejection decision', () => {
    const t0 = mkTick(0, mkLedger([mkRow({ id: 'entry:e1', sourcePlane: 'committed' })]))
    const t1 = mkTick(
      1,
      mkLedger([], [{ candidateId: 'entry:e1', selected: false, reason: 'optimistic-owned-by-committed', evidence: [] }]),
    )
    expect(assertInvariants(resultOf([t0, t1]))).toEqual([])
  })

  it('detects a D11 reference-instability (identical inputs, different ledger object)', () => {
    // Two ticks whose slices are reference-identical, but the pipeline handed
    // back a NEW ledger object — the always-clone defect D11 forbids.
    const slices = EMPTY_SLICES // same reference both ticks → inputs unchanged
    const ledgerA = mkLedger([mkRow({ id: 'entry:e1', sourcePlane: 'committed' })])
    const ledgerB = mkLedger([mkRow({ id: 'entry:e1', sourcePlane: 'committed' })]) // distinct object
    const t0 = mkTick(0, ledgerA, slices)
    const t1 = mkTick(1, ledgerB, slices)
    const violations = assertInvariants(resultOf([t0, t1]))
    expect(violations.map(v => v.kind)).toContain('d11-reference-instability')
  })

  it('does NOT flag a stable ledger reference on a no-op tick', () => {
    const slices = EMPTY_SLICES
    const ledger = mkLedger([mkRow({ id: 'entry:e1', sourcePlane: 'committed' })])
    const t0 = mkTick(0, ledger, slices)
    const t1 = mkTick(1, ledger, slices) // SAME ledger object → contract honoured
    expect(assertInvariants(resultOf([t0, t1]))).toEqual([])
  })
})
