import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createLedgerInputAdapter,
  type RuntimeLedgerSlices,
  type RuntimeSemanticTurn,
} from '@renderer/rendering/adapter/collectLedgerInput'
import { createSessionLedger } from '@renderer/rendering/model/ledger'
import type { RenderLedger } from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// CORPUS REPLAY — real incident recordings through the new pipeline.
//
// testing/rendering-corpus/ holds cases distilled from the debug-bundle
// archive by scripts/rendering/extract-bundle-corpus.mjs: 47 real captures
// (24 claude / 20 codex / 3 opencode) each saved at the moment a rendering
// failure was on screen, with the user's own note. The dir is GITIGNORED
// (real conversation snippets) — this suite self-skips when it's absent,
// so CI stays green while local runs replay the full archive.
//
// What can be asserted honestly: the bundle strips full committed entries
// and ghosts, so the replay has STRICTLY LESS committed knowledge than the
// legacy renderer had at capture time. That asymmetry defines the oracle
// direction:
//   - legacy said NOT owned-by-committed  ⇒  we must not suppress either
//     (we cannot know MORE than legacy; suppressing here means our rules
//     are more aggressive — a real divergence)
//   - legacy said owned                   ⇒  no assertion (we may lack the
//     committed row that justified it)
// Plus unconditional invariants: pipeline never throws, every decision has
// a reason, double-run returns the identical ledger (D11), and no two
// selected candidates share a toolUseId (single-owner invariant).
// ---------------------------------------------------------------------------

const CORPUS_DIR = resolve(__dirname, '../../../../../testing/rendering-corpus')
const hasCorpus = existsSync(CORPUS_DIR)

type OracleBlock = {
  blockIndex: number
  kind?: string
  finalized?: boolean
  textLen?: number
  textOwnedByCommitted?: boolean
  toolOwnedByCommitted?: boolean
  toolResultOwnedByCommitted?: boolean
}
type OracleTurn = { turnId: string; blocks?: OracleBlock[] }
type CorpusCase = {
  name: string
  note: string | null
  provider: 'claude' | 'codex' | 'opencode'
  slices: {
    provider: 'claude' | 'codex' | 'opencode'
    sessionId: string
    entries: unknown[]
    semanticCurrent: (RuntimeSemanticTurn & Record<string, unknown>) | null
    semanticHistory: (RuntimeSemanticTurn & Record<string, unknown>)[]
    streamPhase: string
    lastJsonlEntryAtMs: number | null
  }
  oracles: {
    ownership: { semanticCurrentTurn: OracleTurn | null; semanticHistory: OracleTurn[] } | null
    visibleRows: { rows: { key: string; slot: string }[] } | null
  }
}

function loadCases(): CorpusCase[] {
  return readdirSync(CORPUS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')) as CorpusCase)
}

function runCase(c: CorpusCase): { ledger: RenderLedger; rerun: RenderLedger } {
  const slices: RuntimeLedgerSlices = {
    provider: c.slices.provider,
    sessionId: c.slices.sessionId,
    entries: c.slices.entries as RuntimeLedgerSlices['entries'],
    semanticCurrent: c.slices.semanticCurrent,
    semanticHistory: c.slices.semanticHistory,
    ghosts: new Map(),
    streamPhase: c.slices.streamPhase,
    lastJsonlEntryAtMs: c.slices.lastJsonlEntryAtMs,
  }
  const adapter = createLedgerInputAdapter()
  const ledger = createSessionLedger()
  const first = ledger(adapter(slices).input)
  const rerun = ledger(adapter(slices).input)
  return { ledger: first, rerun }
}

/** Rejection reasons that are MODEL-LEVEL decisions (deliberate rewrite
 *  semantics), not committed-ownership claims — legal even when legacy
 *  showed the block. Everything else rejecting a block legacy showed is
 *  a divergence. */
const OWNERSHIP_REASONS = new Set([
  'committed-text-owned',
  'committed-tool-use-owned',
  'committed-tool-result-owned',
  'claude-whole-turn-suppressed',
])

describe.skipIf(!hasCorpus)('corpus replay: real incident bundles through the pipeline', () => {
  const cases = hasCorpus ? loadCases() : []

  it('loads the full archive', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40)
  })

  for (const c of hasCorpus ? cases : []) {
    describe(`${c.name} [${c.provider}] — ${String(c.note).slice(0, 60)}`, () => {
      it('runs clean: no throw, reasons on every decision, D11 identity, single tool owner', () => {
        const { ledger, rerun } = runCase(c)
        expect(rerun).toBe(ledger)
        for (const d of ledger.decisions) {
          expect(d.reason.length).toBeGreaterThan(0)
        }
        const seenToolIds = new Set<string>()
        for (const row of ledger.rows) {
          const toolId = row.candidate.toolUseId ?? row.candidate.callId
          if (!toolId || row.candidate.contentKind !== 'tool-use') continue
          expect(seenToolIds.has(toolId), `duplicate tool owner ${toolId}`).toBe(false)
          seenToolIds.add(toolId)
        }
      })

      it('never suppresses by ownership where legacy (with MORE committed info) did not', () => {
        if (!c.oracles.ownership) return
        const { ledger } = runCase(c)
        const decisionsById = new Map(ledger.decisions.map(d => [d.candidateId, d]))

        const oracleTurns: OracleTurn[] = [
          ...(c.oracles.ownership.semanticCurrentTurn ? [c.oracles.ownership.semanticCurrentTurn] : []),
          ...c.oracles.ownership.semanticHistory,
        ]
        for (const turn of oracleTurns) {
          for (const b of turn.blocks ?? []) {
            const legacyOwned =
              b.textOwnedByCommitted === true ||
              b.toolOwnedByCommitted === true ||
              b.toolResultOwnedByCommitted === true
            if (legacyOwned) continue // we may lack the committed row — no claim
            const d = decisionsById.get(`sem:${turn.turnId}:${b.blockIndex}`)
            if (!d) continue // collector never minted a candidate (e.g. empty block) — covered by unit tests
            if (d.selected) continue
            // Model-level rejections (compaction kill, duplicate turn,
            // empty blocks) are deliberate rewrite semantics — legal even
            // where legacy painted. Ownership rejections are NOT: we hold
            // strictly less committed info than legacy did.
            if (OWNERSHIP_REASONS.has(d.reason)) {
              expect.fail(
                `turn ${turn.turnId} block ${b.blockIndex} (${b.kind}): legacy showed it, ledger ownership-rejected with ${d.reason}`,
              )
            }
          }
        }
      })
    })
  }
})
