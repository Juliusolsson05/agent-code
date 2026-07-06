import type { RenderLedger } from '@renderer/rendering/model/types'

// ---------------------------------------------------------------------------
// Stage 2 shadow diff: legacy render model vs new-pipeline ledger,
// normalized to comparable units.
//
// WHY normalization exists: the two models legitimately disagree on
// granularity — the legacy renderer paints one item per SEMANTIC TURN
// (SemanticStreamingTurn owns the whole live turn) while the ledger is
// block-level; legacy folds ghosts into `entries` in a pre-pass while the
// ledger keeps them as a distinct plane. Diffing raw shapes would drown
// real divergences in representation noise. A ShadowUnit is the coarsest
// grain BOTH sides can express: a committed/optimistic/ghost row by its
// stable id, a semantic turn by turnId, and the work/empty lifecycle
// flags. Anything the two sides disagree about at THIS grain is a real
// user-visible difference — a row missing, duplicated, or mis-ordered.
//
// This module dies with the shadow at Stage 3 cutover — it deliberately
// imports legacy types nowhere (callers pass pre-projected unit inputs)
// so its tests stay hand-fixture JSON like the rest of the pipeline.
// ---------------------------------------------------------------------------

export type ShadowUnit =
  | { kind: 'row'; id: string }
  | { kind: 'turn'; id: string }
  | { kind: 'work' }
  | { kind: 'empty' }

export function unitKey(u: ShadowUnit): string {
  switch (u.kind) {
    case 'row':
      return `row:${u.id}`
    case 'turn':
      return `turn:${u.id}`
    case 'work':
      return 'work'
    case 'empty':
      return 'empty'
  }
}

/** Legacy FeedRenderItem → unit. Callers hand us the two fields we read
 *  (type + the relevant id) so this module needs no legacy imports; the
 *  hook does the field plucking at the call site. */
export type LegacyItemLike =
  | { type: 'entry'; entryUuid: string | null }
  | { type: 'semantic-history' | 'semantic-current'; turnId: string }
  | { type: 'work' }
  | { type: 'empty' }

export function legacyUnits(items: readonly LegacyItemLike[]): ShadowUnit[] {
  const out: ShadowUnit[] = []
  for (const item of items) {
    switch (item.type) {
      case 'entry':
        // Legacy folds ghosts and optimistic rows into entries; their
        // uuids (g-…, optimistic-codex-user:…) keep them distinguishable
        // at the unit grain without any special-casing here.
        out.push({ kind: 'row', id: item.entryUuid ?? 'no-uuid' })
        break
      case 'semantic-history':
      case 'semantic-current':
        out.push({ kind: 'turn', id: item.turnId })
        break
      case 'work':
        out.push({ kind: 'work' })
        break
      case 'empty':
        out.push({ kind: 'empty' })
        break
    }
  }
  return out
}

export function ledgerUnits(ledger: RenderLedger): ShadowUnit[] {
  const out: ShadowUnit[] = []
  let lastTurnKey: string | null = null
  for (const row of ledger.rows) {
    const c = row.candidate
    switch (c.sourcePlane) {
      case 'committed':
        out.push({ kind: 'row', id: c.id.replace(/^entry:/, '') })
        lastTurnKey = null
        break
      case 'local-submit':
        out.push({ kind: 'row', id: c.id.replace(/^optimistic:/, '') })
        lastTurnKey = null
        break
      case 'ghost':
        out.push({ kind: 'row', id: c.id.replace(/^ghost:/, '') })
        lastTurnKey = null
        break
      case 'semantic': {
        // Collapse consecutive blocks of one turn into a single turn unit —
        // the legacy side renders whole turns, so block-level detail is
        // representation, not divergence.
        const turnId = c.turnId ?? 'unknown-turn'
        if (lastTurnKey !== turnId) {
          out.push({ kind: 'turn', id: turnId })
          lastTurnKey = turnId
        }
        break
      }
      case 'process':
        out.push(c.contentKind === 'work' ? { kind: 'work' } : { kind: 'empty' })
        lastTurnKey = null
        break
      default:
        break
    }
  }
  return out
}

export type ShadowDivergence =
  | { class: 'missing-in-next'; unit: string }
  | { class: 'extra-in-next'; unit: string }
  | { class: 'order-mismatch'; index: number; legacy: string; next: string }

export type ShadowDiffResult = {
  divergences: ShadowDivergence[]
  legacy: string[]
  next: string[]
}

/**
 * Set difference first, order second: a missing/extra unit ALWAYS also
 * shifts order, and reporting the cascade as N order-mismatches buries
 * the one real finding. Order is only compared when the sets agree.
 */
export function diffShadowUnits(
  legacy: readonly ShadowUnit[],
  next: readonly ShadowUnit[],
): ShadowDiffResult {
  const legacyKeys = legacy.map(unitKey)
  const nextKeys = next.map(unitKey)
  const divergences: ShadowDivergence[] = []

  const legacySet = new Set(legacyKeys)
  const nextSet = new Set(nextKeys)
  for (const k of legacySet) {
    if (!nextSet.has(k)) divergences.push({ class: 'missing-in-next', unit: k })
  }
  for (const k of nextSet) {
    if (!legacySet.has(k)) divergences.push({ class: 'extra-in-next', unit: k })
  }

  if (divergences.length === 0) {
    const n = Math.min(legacyKeys.length, nextKeys.length)
    for (let i = 0; i < n; i++) {
      if (legacyKeys[i] !== nextKeys[i]) {
        divergences.push({ class: 'order-mismatch', index: i, legacy: legacyKeys[i], next: nextKeys[i] })
        // First mismatch only — everything after it is the same shift.
        break
      }
    }
    // Duplicate-count drift (same set, different lengths) surfaces as an
    // order mismatch at the first divergent index; if lengths differ but
    // the common prefix matched, report the tail explicitly.
    if (divergences.length === 0 && legacyKeys.length !== nextKeys.length) {
      const i = Math.min(legacyKeys.length, nextKeys.length)
      divergences.push({
        class: 'order-mismatch',
        index: i,
        legacy: legacyKeys[i] ?? '<end>',
        next: nextKeys[i] ?? '<end>',
      })
    }
  }

  return { divergences, legacy: legacyKeys, next: nextKeys }
}
