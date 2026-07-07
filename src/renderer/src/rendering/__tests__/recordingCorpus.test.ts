import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { AgentProviderKind } from '@shared/types/providerKind'
import {
  createLedgerInputAdapter,
  type RuntimeLedgerSlices,
  type RuntimeSemanticTurn,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import type { GhostLike } from '@renderer/rendering/observations/ghosts'
import {
  diffShadowUnits,
  ledgerUnits,
  unitKey,
  type ShadowDivergence,
  type ShadowUnit,
} from '@renderer/rendering/shadow/shadowDiff'
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
  '../../../../../testing/fixtures/rendering-recordings',
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

function reconstructSlices(
  events: readonly RecordingEvent[],
  provider: AgentProviderKind,
  sessionId: string,
): RuntimeLedgerSlices {
  // Committed entries: append-only, first-uuid-wins (mirrors the runtime's
  // seenUuids ingest — a compaction-rewritten window can repeat a uuid and the
  // real feed ingests it once). This is the tractable, fully-faithful half of
  // the fold; the ledger keys committed ownership entirely on these.
  const entries: Record<string, unknown>[] = []
  const seenUuids = new Set<string>()
  let lastJsonlEntryAtMs: number | null = null

  // Minimal semantic fold. Real SemanticEvents are richer and provider-shaped
  // (the boundary type is deliberately `unknown`); this reads the small,
  // stable subset the seeded fixtures use and is a stand-in for the real
  // reducer the shared harness will run.
  let current: MutableTurn | null = null
  const history: MutableTurn[] = []

  // streamPhase drives only the `=== 'idle'` check in the adapter; map
  // process-state.active onto that single distinction.
  let streamPhase = 'idle'

  for (const ev of events) {
    if (ev.ch === '__note' || ev.ch === '__truncated') continue
    const p = payloadOf(ev)
    switch (ev.ch) {
      case 'session:jsonl-entries': {
        // Real shape: { entries: [{ entry, file }] }. Tolerate the flattened
        // shape ({ entries: [entry] }) some early test payloads used.
        const list = Array.isArray(p.entries) ? p.entries : []
        for (const item of list) {
          const entry = (item as { entry?: unknown }).entry ?? item
          const e = entry as { uuid?: string; timestamp?: unknown }
          if (typeof e.uuid === 'string') {
            if (seenUuids.has(e.uuid)) continue
            seenUuids.add(e.uuid)
          }
          entries.push(e as Record<string, unknown>)
          const ms = toMs(e.timestamp)
          if (ms !== null) lastJsonlEntryAtMs = Math.max(lastJsonlEntryAtMs ?? 0, ms)
        }
        break
      }
      case 'session:process-state': {
        streamPhase = p.active === true ? (typeof p.status === 'string' ? p.status : 'active') : 'idle'
        break
      }
      case 'session:semantic-event': {
        const event = (p.event ?? {}) as Record<string, unknown>
        const type = event.type as string | undefined
        const turnId = event.turnId as string | undefined
        if (type === 'turn_started' && turnId) {
          current = {
            turnId,
            source: (event.source as string) ?? null,
            text: typeof event.text === 'string' ? event.text : undefined,
            blocks: {},
            blockOrder: [],
            startedAt: toMs(event.startedAt) ?? ev.wall,
            endedAt: null,
          }
        } else if ((type === 'block_started' || type === 'block_completed' || type === 'block') && current) {
          const bi = typeof event.blockIndex === 'number' ? event.blockIndex : current.blockOrder.length
          current.blocks[bi] = {
            blockIndex: bi,
            kind: (event.kind as string) ?? 'text',
            text: typeof event.text === 'string' ? event.text : undefined,
            finalized: event.finalized === true,
            toolName: event.toolName as string | undefined,
            toolUseId: event.toolUseId as string | undefined,
            callId: event.callId as string | undefined,
            itemId: event.itemId as string | undefined,
          }
          if (!current.blockOrder.includes(bi)) current.blockOrder.push(bi)
        } else if ((type === 'turn_completed' || type === 'turn_stopped') && current) {
          current.endedAt = toMs(event.endedAt) ?? ev.wall
          if (typeof event.text === 'string') current.text = event.text
          history.push(current)
          current = null
        }
        break
      }
      default:
        // started / exit / conditions / sub-agents / screen / jsonl-error do
        // not feed the ledger input; the shared harness routes them into the
        // fold, but the ledger-level replay ignores them.
        break
    }
  }

  return {
    provider,
    sessionId,
    entries,
    semanticCurrent: current,
    semanticHistory: history,
    ghosts: new Map<string, GhostLike>(),
    streamPhase,
    lastJsonlEntryAtMs,
  }
}

const files = existsSync(FIXTURE_DIR)
  ? readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'))
  : []

describe.skipIf(files.length === 0)(`recording corpus (${files.length} recordings)`, () => {
  for (const file of files) {
    const path = join(FIXTURE_DIR, file)
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as RecordingFixture

    it(`${fixture.meta.recordingId ?? file} — ${(fixture.meta.note ?? 'no note').slice(0, 60)}`, () => {
      const provider = (fixture.meta.provider ?? 'claude') as AgentProviderKind
      const sessionId = fixture.meta.sessionId ?? 'rec-session'
      const slices = reconstructSlices(fixture.events, provider, sessionId)
      const ledger = createSessionLedger()(createLedgerInputAdapter()(slices).input)
      const next = ledgerUnits(ledger)

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
