import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { AgentProviderKind } from '@shared/types/providerKind'
import {
  createLedgerInputAdapter,
  type RuntimeLedgerSlices,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import type { GhostLike } from '@renderer/rendering/observations/ghosts'
import {
  diffShadowUnits,
  ledgerUnits,
  legacyUnits,
  unitKey,
  type LegacyItemLike,
  type ShadowDivergence,
  type ShadowUnit,
} from '@renderer/rendering/shadow/shadowDiff'

// ---------------------------------------------------------------------------
// Bundle corpus: 46 real debug bundles, each saved at the moment a rendering
// bug was visible, replayed through the new pipeline and diffed against the
// rows the LEGACY renderer actually painted (recorded visible_rows — ground
// truth, not recomputed). Extraction: scripts/extract-rendering-fixtures.mjs.
//
// TRIAGE MODEL — this suite asserts STABILITY, not blanket parity:
// each fixture carries a `triage` array; the diff must match it exactly.
// A divergence can be RIGHT (the note on most bundles describes a legacy
// bug — the new pipeline disagreeing is the fix working). Verdicts are the
// live set produced by scripts/triage-rendering-fixtures.mjs (that script is
// the source of truth; keep this list in sync with it):
//   - 'skew-ingestion-lag' — a committed row whose producer timestamp
//     precedes the recorded visible_rows moment but ingestion had not drained
//     it yet; legacy could not paint what it had not seen.
//   - 'equivalent-content' — the SAME visible content, painted by the pipeline
//     via committed rows where legacy painted the not-yet-ingested semantic
//     turn. Suppression is correct; the divergence is representational only.
//   - 'extraction-gap[:variant]' — a row the pipeline cannot reconstruct
//     because no on-disk source carries it (variants: ':history-window' — older
//     than the 20-turn history cap; ':optimistic-rows-renderer-local' — exists
//     only in renderer state).
//   - 'legacy-bug[:variant]' — the divergence IS the fix, keep it forever
//     (variants: ':scaffolding-echo' — legacy painted a <command/context> echo
//     as a user prompt; ':prompt-not-shown' — legacy failed to paint a real
//     user prompt).
//   - 'untriaged' — recorded debt not yet mechanically classified; burn down
//     in follow-ups. These deliberately carry NO `why` (the `why?` field is
//     optional precisely so an untriaged entry can exist without one); a why is
//     only written when the triage script can justify a real verdict.
// ANY change in the divergence set — new ones appearing or old ones vanishing —
// fails the suite until a human re-blesses, so pipeline regressions cannot hide
// inside pre-existing noise.
//
// Bless mode: AGENT_CODE_CORPUS_BLESS=1 rewrites each fixture's triage to
// the current diff (new entries land as 'untriaged'). Never bless without
// reading the failures first.
//
// COMPARISON SCOPE per fixture:
// - work/empty units are dropped from BOTH sides: the expected rows and the
//   state snapshot are captured ticks apart, so phase-indicator presence is
//   pure skew noise.
// - fixtures without transcript reconstruction (codex/opencode v1 — the
//   rollout→Entry mapping lives in-app) compare only ghost/optimistic rows
//   and semantic turns; committed-entry rows are dropped from both sides.
// ---------------------------------------------------------------------------

const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../testing/fixtures/rendering-bundles',
)
const BLESS = process.env.AGENT_CODE_CORPUS_BLESS === '1'

type BundleFixture = {
  meta: {
    bundleId: string
    note: string | null
    kind: string
    entriesSource: string
  }
  input: {
    provider: string
    streamPhase: string
    streamPhasePendingToolName: string | null
    streamPhasePendingToolUseId: string | null
    lastJsonlEntryAt: number | null
    entries: Record<string, unknown>[]
    semanticCurrent: unknown
    semanticHistory: unknown[]
    ghosts: Record<string, GhostLike>
  }
  expected: {
    rows: { key: string; slot: string; itemType: string }[]
  }
  triage: { divergence: ShadowDivergence; verdict: string; why?: string }[]
}

function expectedToLegacyItems(fixture: BundleFixture): LegacyItemLike[] {
  const items: LegacyItemLike[] = []
  for (const r of fixture.expected.rows) {
    if (r.slot === 'entry') {
      items.push({ type: 'entry', entryUuid: r.key.replace(/^entry:/, '') })
    } else if (r.itemType === 'semantic-current' || r.key.startsWith('semantic:')) {
      items.push({ type: 'semantic-current', turnId: r.key.replace(/^semantic:/, '') })
    } else if (r.itemType === 'semantic-history' || r.key.startsWith('semantic-history:')) {
      items.push({ type: 'semantic-history', turnId: r.key.replace(/^semantic-history:/, '') })
    } else if (r.slot === 'work') {
      items.push({ type: 'work' })
    } else if (r.slot === 'empty') {
      items.push({ type: 'empty' })
    }
  }
  return items
}

function scopeUnits(units: ShadowUnit[], hasEntries: boolean, hasGhosts: boolean): ShadowUnit[] {
  return units.filter(u => {
    if (u.kind === 'work' || u.kind === 'empty') return false
    if (u.kind === 'row') {
      const isGhost = u.id.startsWith('g-')
      const isOptimistic = u.id.startsWith('optimistic-')
      // Optimistic rows ride inside runtime.entries — without transcript
      // reconstruction they cannot exist on the input side; comparing them
      // would report the extraction gap as a pipeline miss.
      if (isOptimistic && !hasEntries) return false
      // Ghost journals only exist for sessions after journaling shipped
      // (~June 24); expected g- rows from before that are unreconstructable.
      if (isGhost && !hasGhosts) return false
      if (!isGhost && !isOptimistic && !hasEntries) return false
    }
    return true
  })
}

const files = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'))

describe(`bundle corpus (${files.length} real debug bundles)`, () => {
  for (const file of files) {
    const path = join(FIXTURE_DIR, file)
    const fixture = JSON.parse(readFileSync(path, 'utf8')) as BundleFixture

    it(`${fixture.meta.bundleId} — ${(fixture.meta.note ?? 'no note').slice(0, 60)}`, () => {
      const provider = fixture.input.provider as AgentProviderKind
      const slices: RuntimeLedgerSlices = {
        provider,
        sessionId: fixture.meta.bundleId,
        entries: fixture.input.entries,
        semanticCurrent: fixture.input.semanticCurrent as RuntimeLedgerSlices['semanticCurrent'],
        semanticHistory: fixture.input.semanticHistory as RuntimeLedgerSlices['semanticHistory'],
        ghosts: new Map(Object.entries(fixture.input.ghosts)),
        streamPhase: fixture.input.streamPhase,
        lastJsonlEntryAtMs: fixture.input.lastJsonlEntryAt,
      }
      const ledger = createSessionLedger()(createLedgerInputAdapter()(slices).input)

      const hasEntries = fixture.meta.entriesSource !== 'none'
      const hasGhosts = Object.keys(fixture.input.ghosts).length > 0
      const legacy = scopeUnits(legacyUnits(expectedToLegacyItems(fixture)), hasEntries, hasGhosts)
      const next = scopeUnits(ledgerUnits(ledger), hasEntries, hasGhosts)
      const diff = diffShadowUnits(legacy, next)

      if (BLESS) {
        const prior = new Map(fixture.triage.map(t => [JSON.stringify(t.divergence), t]))
        fixture.triage = diff.divergences.map(d => {
          const key = JSON.stringify(d)
          return prior.get(key) ?? { divergence: d, verdict: 'untriaged' }
        })
        writeFileSync(path, JSON.stringify(fixture))
      }

      expect(diff.divergences).toEqual(fixture.triage.map(t => t.divergence))

      // Sanity floor even under heavy divergence: the pipeline must never
      // paint NOTHING when the legacy renderer painted something.
      if (legacy.length > 0) {
        expect(next.length, `pipeline painted zero units (legacy painted ${legacy.length}): ${legacy.slice(0, 5).map(unitKey).join(', ')}…`).toBeGreaterThan(0)
      }
    })
  }
})
