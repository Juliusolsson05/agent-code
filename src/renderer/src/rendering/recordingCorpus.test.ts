import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { AgentProviderKind } from '@shared/types/providerKind'
import { createLedgerInputAdapter } from '@renderer/rendering/adapter/collectLedgerInput'
import type {
  RuntimeLedgerSlices,
  RuntimeSemanticTurn,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import { parseRecording, replayRecording } from '@renderer/rendering/replay/recordedSession'
import type { ReplayItemsProjection } from '@renderer/rendering/replay/recordedSession'
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
import type { GhostLike } from '@renderer/rendering/observations/ghosts'
import { diffShadowUnits, ledgerUnits, unitKey } from '@renderer/rendering/shadow/shadowDiff'
import type { ShadowDivergence, ShadowUnit } from '@renderer/rendering/shadow/shadowDiff'
import type { RecordingEvent } from '@renderer/rendering/replay/redact'

// ---------------------------------------------------------------------------
// Recording corpus (plan §6, Mode 1 — golden replay). Each fixture is a
// REDACTED session recording — a stream of the 9 SessionFeed channels captured
// live and scrubbed by scripts/extract-rendering-recordings.mjs. We replay the
// stream through the REAL pipeline and assert the rows it produces are STABLE
// against the checked-in golden (`expected`). A pipeline change that alters the
// rows for a recorded input fails here until a human re-blesses.
//
// HOW THIS DIFFERS FROM bundleCorpus.test.ts: a bundle carries recorded LEGACY
// output as external ground truth, so its `expected` is fixed and `triage`
// records accepted legacy-vs-new divergences. A recording has NO external
// ground truth (there is no legacy renderer in the loop) — the golden IS the
// pipeline's own last-blessed output. So bless REWRITES `expected` to the
// current rows (plan §6: "BLESS rewrites expected output") and `triage` is
// normally empty; it exists only so a human can knowingly tolerate a
// divergence without re-blessing. Any un-tolerated change fails loudly.
//
// Bless: AGENT_CODE_RECORDING_BLESS=1. Never bless without reading the diff.
//
// SELF-SKIP: the suite skips when the fixtures dir is empty/absent so CI stays
// green until real recordings land. It is SEEDED with hand-built fixtures so it
// is not vacuously skipped today.
//
// REPLAY IS INLINE, ON PURPOSE (temporary). Slice 4's shared replay harness
// (RecordedSessionFeed implements SessionFeed → the real fold →
// SessionRuntime → adapter) is being built on another branch and does not
// exist on this base. So `reconstructSlices` below folds the recorded events
// into `RuntimeLedgerSlices` DIRECTLY — a small, local stand-in for what the
// full fold will centralize. It intentionally covers only the reconstruction
// the seeded fixtures exercise (committed entries, stream phase, and a minimal
// semantic-turn fold); real recordings replayed through the shared harness will
// exercise the fold's full behavior. A later integration commit swaps this
// inline reconstruction for the shared harness with no fixture changes (the
// fixtures speak the channel stream, not the reconstruction).
// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../testing/fixtures/rendering-recordings',
)
const BLESS = process.env.AGENT_CODE_RECORDING_BLESS === '1'

type RecordingFixture = {
  meta: {
    recordingId: string | null
    sessionId: string | null
    provider: string | null
    note: string | null
  }
  events: RecordingEvent[]
  expected: { units: ShadowUnit[] }
  triage: { divergence: ShadowDivergence; verdict: string; why?: string }[]
}

// --- Minimal event → RuntimeLedgerSlices fold (see header) -------------------

type MutableTurn = RuntimeSemanticTurn

function payloadOf(ev: RecordingEvent): Record<string, unknown> {
  return (ev.payload ?? {}) as Record<string, unknown>
}

function toMs(ts: unknown): number | null {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts
  if (typeof ts === 'string') {
    const ms = Date.parse(ts)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}


const files = existsSync(FIXTURE_DIR)
  ? readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'))
  : []

describe.skipIf(files.length === 0)(`recording corpus (${files.length} recordings)`, () => {
  for (const file of files) {
    const path = join(FIXTURE_DIR, file)
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as RecordingFixture

    it(`${fixture.meta.recordingId ?? file} — ${(fixture.meta.note ?? 'no note').slice(0, 60)}`, () => {
      // Replay through the SHARED harness (replay/recordedSession.ts) rather
      // than a local fold: it reuses the real leaf reducers and holds the
      // adapter/ledger across ticks so D11 identity is real. The golden is
      // the FINAL tick's ledger — the whole recording folded to its end
      // state. (Was a local reconstructSlices stand-in; unified onto B's
      // harness at integration, no fixture change.)
      const parsed = parseRecording({
        header: {
          v: 1,
          recordingId: fixture.meta.recordingId ?? file,
          sessionId: fixture.meta.sessionId ?? 'rec-session',
          provider: fixture.meta.provider ?? 'claude',
          providerSessionId: null,
          cwd: null,
          appVersion: null,
          startedAtWall: 0,
        },
        // fixture.events is the recorded {t,wall,ch,payload} shape, which is
        // structurally the harness's RecordedLine; cast across the local type.
        events: fixture.events as unknown as Parameters<typeof parseRecording>[0]['events'],
      })
      const replayed = replayRecording(parsed, { projectItems })
      const finalLedger =
        replayed.ticks.length > 0
          ? replayed.ticks[replayed.ticks.length - 1].ledger
          : createSessionLedger()(createLedgerInputAdapter()({
              provider: (fixture.meta.provider ?? 'claude') as AgentProviderKind,
              sessionId: fixture.meta.sessionId ?? 'rec-session',
              entries: [],
              semanticCurrent: null,
              semanticHistory: [],
              ghosts: new Map(),
              streamPhase: 'idle',
              lastJsonlEntryAtMs: null,
            }).input)
      const next = ledgerUnits(finalLedger)

      if (BLESS) {
        // Self-golden: the pipeline output IS the new golden. Rewrite expected
        // and clear triage (a fresh bless tolerates nothing implicitly).
        fixture.expected = { units: next }
        fixture.triage = []
        writeFileSync(path, JSON.stringify(fixture))
      }

      const diff = diffShadowUnits(fixture.expected.units, next)
      expect(diff.divergences).toEqual(fixture.triage.map(t => t.divergence))

      // Sanity floor: if the golden expected any rows, replay must not paint
      // nothing (a total-blank regression would otherwise slip through as a
      // pile of missing-in-next divergences someone could bless away).
      if (fixture.expected.units.length > 0) {
        expect(
          next.length,
          `replay painted zero units (golden had ${fixture.expected.units.length}): ` +
            `${fixture.expected.units.slice(0, 5).map(unitKey).join(', ')}…`,
        ).toBeGreaterThan(0)
      }
    })
  }
})
