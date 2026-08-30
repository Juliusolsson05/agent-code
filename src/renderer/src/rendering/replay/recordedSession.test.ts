import { describe, expect, it, vi, afterEach } from 'vitest'

import { parseRecording, replayRecording } from '@renderer/rendering/replay/recordedSession'
import type {
  RecordingHeader,
  RecordedLine,
  ReplayItemsProjection,
} from '@renderer/rendering/replay/recordedSession'
import {
  ledgerToFeedItems,
} from '@renderer/features/feed/ledger/ledgerFeedItems'
import { providerLedgerFeedContextFromRuntime } from '@renderer/features/feed/ledger/providerLedgerFeedContext'

// The REAL feed-owned view bridge, injected through the harness's
// projectItems seam (#493 PR-3): the harness itself may not import
// features/, but this test's whole point is exercising the full stack —
// including the #239 dropped-candidate accounting — so it supplies the
// production bridge.
const projectItems: ReplayItemsProjection = (ledger, view, provider) =>
  ledgerToFeedItems(
    ledger,
    providerLedgerFeedContextFromRuntime(view, provider).context,
  )

// ---------------------------------------------------------------------------
// Slice 4 — replay-harness round trip. Hand-build a small recording (the 9
// SessionFeed channels as the recorder would capture them), replay it through
// the REAL pipeline, and assert on the rows it produces tick by tick — the
// "bundleCorpus × N ticks" shape the seam research described, but driven from
// the input EVENT STREAM instead of a frozen slice snapshot.
//
// This is a `.test.ts` (node `unit` project) on purpose: the rewrite plan §4
// exempts src/renderer/src/rendering/ from the no-new-tests rule, and the
// harness is deliberately pure (no React, no DOM, no fs) so it runs here rather
// than under the happy-dom `renderer` project.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000
const iso = (ms: number): string => new Date(ms).toISOString()

const HEADER: RecordingHeader = {
  v: 1,
  recordingId: 'rec-round-trip',
  sessionId: 's1',
  provider: 'claude',
  providerSessionId: 'psid-1',
  cwd: '/work',
  appVersion: '0.0.0',
  startedAtWall: T,
}

/** One events.jsonl line as the recorder writes it. */
function ev(t: number, ch: string, payload: unknown): RecordedLine {
  return { t, wall: T + t, ch, payload } as RecordedLine
}

/**
 * A realistic Claude session: a user prompt commits, an assistant turn streams
 * a text block and a tool_use block, the committed assistant entry lands (which
 * takes ownership of the streamed tool), the turn completes, the process exits.
 * Interleaved no-op channels (screen, usage_updated) exist to exercise the D11
 * cache — they change nothing the ledger reads and MUST reuse the ledger object.
 */
function buildRecording(): RecordedLine[] {
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
    ev(20, 'session:semantic-event', {
      sessionId: 's1',
      event: { type: 'turn_started', turnId: 'turn_live', source: 'proxy' },
    }),
    ev(30, 'session:semantic-event', {
      sessionId: 's1',
      event: { type: 'block_started', turnId: 'turn_live', blockIndex: 0, kind: 'text', source: 'proxy' },
    }),
    ev(40, 'session:semantic-event', {
      sessionId: 's1',
      event: { type: 'text_delta', turnId: 'turn_live', blockIndex: 0, textDelta: 'Hello, working.' },
    }),
    ev(45, 'session:semantic-event', {
      sessionId: 's1',
      event: {
        type: 'block_started',
        turnId: 'turn_live',
        blockIndex: 1,
        kind: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'toolu_1',
        source: 'proxy',
      },
    }),
    // No-op tick for the ledger: a screen frame moves nothing the pipeline reads.
    ev(50, 'session:screen', {
      sessionId: 's1',
      plain: 'x',
      markdown: 'x',
      recent: 'x',
      recentMarkdown: 'x',
      picker: { visible: false, items: [] },
    }),
    // Committed assistant entry — carries the same text + the streamed tool.
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
    // Another no-op tick for the ledger: usage_updated folds to no semantic change.
    ev(60, 'session:semantic-event', { sessionId: 's1', event: { type: 'usage_updated', turnId: 'turn_live' } }),
    ev(70, 'session:semantic-event', { sessionId: 's1', event: { type: 'turn_completed', turnId: 'turn_live' } }),
    ev(80, 'session:exit', { sessionId: 's1', exitCode: 0 }),
  ]
}

afterEach(() => {
  vi.useRealTimers()
})

describe('replay harness — recorded-session round trip', () => {
  it('replays a hand-built recording and produces the expected rows tick by tick', () => {
    vi.useFakeTimers()
    const recording = parseRecording({ header: HEADER, events: buildRecording() })
    const replay = replayRecording(recording, { onBeforeFold: w => vi.setSystemTime(w), projectItems })

    const rowIds = replay.ticks.map(t => t.rows.map(r => r.candidate.id))

    // The committed user prompt appears the moment its JSONL burst lands.
    expect(rowIds[1]).toEqual(['entry:u1'])

    // The streamed text + tool blocks both paint while the turn is live.
    const streaming = replay.ticks.find(t =>
      t.rows.some(r => r.candidate.id === 'sem:turn_live:1'),
    )
    expect(streaming?.rows.map(r => r.candidate.id)).toEqual([
      'entry:u1',
      'sem:turn_live:0',
      'sem:turn_live:1',
    ])

    // Once the committed assistant entry lands it TAKES OVER the tool: the live
    // tool row is suppressed (committed-tool-use-owned) and entry:a1 owns it.
    const afterCommit = replay.ticks[7]
    expect(afterCommit.rows.map(r => r.candidate.id)).toEqual([
      'entry:u1',
      'sem:turn_live:0',
      'entry:a1',
    ])
    const toolDecision = afterCommit.ledger.decisions.find(d => d.candidateId === 'sem:turn_live:1')
    expect(toolDecision?.selected).toBe(false)
    expect(toolDecision?.reason).toBe('committed-tool-use-owned')

    // Final state after exit: the two committed rows survive; the torn-down
    // live preview is gone (its content lives on in entry:a1).
    expect(rowIds.at(-1)).toEqual(['entry:u1', 'entry:a1'])

    // The full stack ran through the view bridge with no unresolved candidates
    // (a dropped candidate is the #239 "present but invisible" class).
    for (const tick of replay.ticks) {
      expect(tick.dropped).toEqual([])
      expect(tick.feedItems.length).toBeGreaterThan(0)
    }
  })

  it('reuses the SAME ledger object on ticks whose inputs did not change (D11)', () => {
    vi.useFakeTimers()
    const recording = parseRecording({ header: HEADER, events: buildRecording() })
    const replay = replayRecording(recording, { onBeforeFold: w => vi.setSystemTime(w), projectItems })

    // Tick 6 is the screen frame that follows the tool block_started (tick 5).
    // A screen event moves no ledger slice, so the adapter's plane caches all
    // hit and the ledger returns its PREVIOUS object — the load-bearing D11
    // contract (adapter.test.ts:119-149) observed over a real event stream.
    const screenTick = replay.ticks[6]
    expect(screenTick.line.ch).toBe('session:screen')
    expect(screenTick.ledger).toBe(replay.ticks[5].ledger)

    // usage_updated (tick 8) is a semantic no-op → same object again.
    const usageTick = replay.ticks[8]
    expect(usageTick.line.ch).toBe('session:semantic-event')
    expect(usageTick.ledger).toBe(replay.ticks[7].ledger)

    // Sanity: a REAL change (the committed burst at tick 7) must mint a NEW
    // object — otherwise "same object" above would be vacuously true.
    expect(replay.ticks[7].ledger).not.toBe(replay.ticks[6].ledger)
  })

  it('parses the events body from a raw JSONL string and tolerates a torn tail', () => {
    vi.useFakeTimers()
    const lines = buildRecording().map(l => JSON.stringify(l))
    // Simulate a crash mid-append: a trailing partial line the recorder never
    // finished flushing. parseRecording must skip it, not throw.
    const body = lines.join('\n') + '\n{"t":999,"wall":1,"ch":"session:scre'
    const recording = parseRecording({ header: HEADER, events: body })
    // The torn line is dropped; every complete line survives.
    expect(recording.lines).toHaveLength(buildRecording().length)

    const replay = replayRecording(recording, { onBeforeFold: w => vi.setSystemTime(w), projectItems })
    expect(replay.ticks.at(-1)?.rows.map(r => r.candidate.id)).toEqual(['entry:u1', 'entry:a1'])
  })

  it('skips synthetic diagnostics for pipeline input', () => {
    vi.useFakeTimers()
    const withNotes: RecordedLine[] = [
      ...buildRecording().slice(0, 2),
      { t: 12, wall: T + 12, ch: '__note', note: { id: 'n1', status: 'reserved' } },
      { t: 15, wall: T + 15, ch: '__note', note: { id: 'n1', status: 'filled', text: 'reads vanished here' } },
      {
        t: 16,
        wall: T + 16,
        ch: '__codex_transcript_observation',
        observation: {
          schemaVersion: 1,
          name: 'submit.surface',
          ids: { sessionId: 's-replay', submissionId: 'sub-1' },
          data: { surface: 'queue-visible' },
        },
      },
      ...buildRecording().slice(2),
      { t: 90, wall: T + 90, ch: '__truncated', reason: 'size-cap', bytes: 1234 },
    ]
    const recording = parseRecording({ header: HEADER, events: withNotes })
    const replay = replayRecording(recording, { onBeforeFold: w => vi.setSystemTime(w), projectItems })

    // Notes/tombstones are preserved in the parsed line list (triage tooling
    // reads them) but produce NO pipeline tick — the tick count equals the
    // number of real feed events.
    expect(recording.lines.some(l => l.ch === '__note')).toBe(true)
    expect(recording.lines.some(l => l.ch === '__codex_transcript_observation')).toBe(true)
    expect(replay.ticks.every(t => t.line.ch.startsWith('session:'))).toBe(true)
    expect(replay.ticks).toHaveLength(buildRecording().length)
  })
})

export { HEADER as ROUND_TRIP_HEADER, buildRecording as buildRoundTripRecording }
