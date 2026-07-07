import type { RenderRow, OwnershipDecision } from '@renderer/rendering/model/types'
import type { ReplayResult, ReplayTick } from '@renderer/rendering/replay/recordedSession'

// ---------------------------------------------------------------------------
// Slice 5 — invariant replay (plan §6 Mode 2). Assert, at EVERY tick, the four
// properties the ledger promises by construction. No hand-authored expected
// output: these catch whole bug CLASSES, so they can run over any recording —
// the broadest, cheapest regression net (and the permanent successor to the
// dev-only render shadow, which dies at Stage-3 cutover).
//
// The four invariants (plan §6):
//   1. single-owner (dual-render): within one tick, no artifact is owned by two
//      selected rows — no duplicate row id, no shared toolUseId, no shared
//      (turnId, blockIndex), no shared exact textKey.
//   2. no-vanish-without-replacement: a row visible at tick N and gone at N+1
//      must be EXPLAINED — either a rejection decision names it at N+1, or a
//      selected row at N+1 covers the same artifact (turn archival, ghost→
//      committed handoff). An unexplained disappearance is the #469 class.
//   3. no-unexplained-shrink: the aggregate of (2) — if the selected row count
//      drops, every dropped row must be explained. Reported separately so a
//      net shrink is visible even when individual rows technically "moved".
//   4. D11 reference stability: a tick whose adapter-relevant slices did not
//      change (by reference/value) MUST yield the SAME RenderLedger object.
//      adapter.test.ts:119-149 is the executable spec; this runs it over a real
//      stream.
//
// `assertInvariants` returns violations rather than throwing so a test can
// assert `toEqual([])` (clear diff on failure) and a future soak tool can
// aggregate them across a corpus.
// ---------------------------------------------------------------------------

/** Work / empty are LIFECYCLE indicators, not content — they toggle on every
 *  phase edge (streaming↔idle) and are captured ticks apart from the rows they
 *  accompany. bundleCorpus.test.ts drops them from BOTH sides of its diff for
 *  exactly this reason (`scopeUnits`), and so must the invariants: an
 *  empty↔work↔content toggle is expected, never a "vanish" or a dual-render. */
function isLifecycleRow(row: RenderRow): boolean {
  const kind = row.candidate.contentKind
  return kind === 'work' || kind === 'empty'
}

export type InvariantKind =
  | 'dual-render'
  | 'vanish-without-replacement'
  | 'unexplained-shrink'
  | 'd11-reference-instability'

export type InvariantViolation = {
  kind: InvariantKind
  /** Tick index the violation was observed AT (for 2/3/4 this is the N+1 tick,
   *  the one where the bad transition landed). */
  tick: number
  message: string
  /** Structured evidence for debugging — ids, counts, the offending decision. */
  detail?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Invariant 1 — single owner (dual render)
// ---------------------------------------------------------------------------

/** Every ownership KEY a selected row asserts. A key appearing on two selected
 *  rows in the same tick is a dual-render: the ledger's whole job is to pick
 *  exactly one owner per artifact. */
function ownershipKeysOf(row: RenderRow): string[] {
  const c = row.candidate
  const keys: string[] = [`id:${c.id}`]
  // A tool-use candidate owns its toolUseId; a committed entry owns the
  // toolUseIds it carries (ownedToolUseIds). If BOTH a semantic tool row and a
  // committed row claiming the same id survive selection, that is the exact
  // "tool card painted twice" bug the ledger's ownership pass exists to prevent.
  if (c.toolUseId) keys.push(`tool:${c.toolUseId}`)
  for (const id of c.ownedToolUseIds ?? []) keys.push(`tool:${id}`)
  // Block-grain identity for semantic rows.
  if (c.turnId !== undefined && c.blockIndex !== undefined) {
    keys.push(`block:${c.turnId}:${c.blockIndex}`)
  }
  // Exact committed-text ownership (never fuzzy — matches the ledger's own
  // textKey discipline). Two selected rows with the identical textKey means an
  // optimistic echo was not suppressed by its committed twin (#465 family).
  if (c.textKey) keys.push(`text:${c.textKey}`)
  return keys
}

function checkSingleOwner(tick: ReplayTick, out: InvariantViolation[]): void {
  const owners = new Map<string, string>() // key → first row id that claimed it
  for (const row of tick.rows) {
    if (isLifecycleRow(row)) continue
    for (const key of ownershipKeysOf(row)) {
      const prevOwner = owners.get(key)
      if (prevOwner !== undefined && prevOwner !== row.candidate.id) {
        out.push({
          kind: 'dual-render',
          tick: tick.index,
          message: `two selected rows own the same artifact "${key}": ${prevOwner} and ${row.candidate.id}`,
          detail: { key, first: prevOwner, second: row.candidate.id },
        })
      } else if (prevOwner === row.candidate.id) {
        // Same row asserting the same key twice would mean the row appears
        // twice in `rows` — also a dual render.
        out.push({
          kind: 'dual-render',
          tick: tick.index,
          message: `row ${row.candidate.id} appears twice in the ledger rows`,
          detail: { key, id: row.candidate.id },
        })
      } else {
        owners.set(key, row.candidate.id)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Invariants 2 & 3 — no vanish / shrink without a recorded explanation
// ---------------------------------------------------------------------------

function rejectionByCandidateId(
  decisions: readonly OwnershipDecision[],
): Map<string, OwnershipDecision> {
  const map = new Map<string, OwnershipDecision>()
  for (const d of decisions) {
    if (!d.selected) map.set(d.candidateId, d)
  }
  return map
}

/** The set of artifact identities a tick's SELECTED rows cover. Used to decide
 *  whether a vanished row was "replaced" (its artifact still on screen under a
 *  different candidate id — e.g. a current-turn block that archived into a
 *  history row keeps the same turnId). */
function coveredArtifacts(tick: ReplayTick): Set<string> {
  const set = new Set<string>()
  for (const row of tick.rows) {
    const c = row.candidate
    if (c.turnId !== undefined) set.add(`turn:${c.turnId}`)
    if (c.toolUseId) set.add(`tool:${c.toolUseId}`)
    for (const id of c.ownedToolUseIds ?? []) set.add(`tool:${id}`)
    if (c.textKey) set.add(`text:${c.textKey}`)
  }
  return set
}

function artifactsOf(row: RenderRow): string[] {
  const c = row.candidate
  const out: string[] = []
  if (c.turnId !== undefined) out.push(`turn:${c.turnId}`)
  if (c.toolUseId) out.push(`tool:${c.toolUseId}`)
  if (c.textKey) out.push(`text:${c.textKey}`)
  return out
}

/** The turnIds still alive in the runtime this tick — the current turn plus
 *  every archived history turn. A live semantic row whose turn is NOT here has
 *  had its whole turn torn down (session exit, or a provider that clears the
 *  turn), which is a legitimate fold transition, not a ledger vanish: a turn
 *  that left the runtime produces no candidate, so the ledger cannot (and
 *  should not) record a rejection for it. Read from the reconstructed slices,
 *  so it reflects the real fold state, not a guess. */
function liveTurnIds(tick: ReplayTick): Set<string> {
  const set = new Set<string>()
  const cur = tick.slices.semanticCurrent
  if (cur) set.add(cur.turnId)
  for (const t of tick.slices.semanticHistory) set.add(t.turnId)
  return set
}

function checkVanish(prev: ReplayTick, cur: ReplayTick, out: InvariantViolation[]): void {
  const curIds = new Set(cur.rows.map(r => r.candidate.id))
  const rejected = rejectionByCandidateId(cur.ledger.decisions)
  const covered = coveredArtifacts(cur)
  const curLiveTurns = liveTurnIds(cur)

  let unexplainedDrops = 0
  for (const prevRow of prev.rows) {
    if (isLifecycleRow(prevRow)) continue // work/empty toggle is not a vanish
    const id = prevRow.candidate.id
    if (curIds.has(id)) continue // still selected — not a vanish

    // Explanation A: the ledger recorded a rejection decision for this exact
    // candidate at the new tick. This is the ledger's by-construction promise
    // (plan §6): every candidate that reached the ledger has a decision.
    if (rejected.has(id)) continue

    // Explanation B: a replacement covers the same artifact. Turn archival
    // (current-turn block → history row) and ghost→committed handoff change the
    // candidate id but keep the turn/tool/text artifact on screen. If ANY of
    // this row's artifacts is still covered by a selected row, the content did
    // not vanish — its owner changed, which is legitimate.
    const arts = artifactsOf(prevRow)
    if (arts.length > 0 && arts.some(a => covered.has(a))) continue

    // Explanation C: a LIVE semantic row whose turn no longer exists in the
    // runtime. The turn was torn down (exit clears currentTurn; some providers
    // clear on turn end) — the streaming preview legitimately disappears. Its
    // committed twin, if any, carries the durable copy. This is NOT the #469
    // class (that is committed/queue content vanishing while its turn is still
    // live), so gate strictly on "the turn itself is gone".
    if (
      prevRow.candidate.sourcePlane === 'semantic' &&
      prevRow.candidate.turnId !== undefined &&
      !curLiveTurns.has(prevRow.candidate.turnId)
    ) {
      continue
    }

    // Neither explanation holds: the row disappeared and nothing accounts for
    // it. This is the #469 "queue-desync / row silently vanished" class.
    unexplainedDrops += 1
    out.push({
      kind: 'vanish-without-replacement',
      tick: cur.index,
      message: `row ${id} was selected at tick ${prev.index} but vanished at tick ${cur.index} with no rejection decision and no replacement`,
      detail: { id, prevTick: prev.index, artifacts: arts },
    })
  }

  // Invariant 3 — surface a NET shrink explicitly, even if every drop happened
  // to be individually explained above (in which case unexplainedDrops is 0 and
  // this is silent). A shrink with unexplained drops is double-reported on
  // purpose: the per-row cause (2) AND the aggregate signal (3).
  const shrink = prev.rows.length - cur.rows.length
  if (shrink > 0 && unexplainedDrops > 0) {
    out.push({
      kind: 'unexplained-shrink',
      tick: cur.index,
      message: `selected row count fell by ${shrink} (from ${prev.rows.length} to ${cur.rows.length}) with ${unexplainedDrops} unexplained drop(s)`,
      detail: {
        from: prev.rows.length,
        to: cur.rows.length,
        unexplainedDrops,
      },
    })
  }
}

// ---------------------------------------------------------------------------
// Invariant 4 — D11 reference stability
// ---------------------------------------------------------------------------

/** True iff the two ticks fed adapter-identical slices — i.e. every plane the
 *  ledger keys on is the SAME reference/value. The pending-tool fields feed the
 *  VIEW, not the ledger, so they are intentionally excluded: the ledger object
 *  identity contract is about the six adapter inputs only. */
function ledgerInputsUnchanged(prev: ReplayTick, cur: ReplayTick): boolean {
  return (
    prev.slices.provider === cur.slices.provider &&
    prev.slices.sessionId === cur.slices.sessionId &&
    prev.slices.entries === cur.slices.entries &&
    prev.slices.semanticCurrent === cur.slices.semanticCurrent &&
    prev.slices.semanticHistory === cur.slices.semanticHistory &&
    prev.slices.ghosts === cur.slices.ghosts &&
    prev.slices.streamPhase === cur.slices.streamPhase &&
    prev.slices.lastJsonlEntryAtMs === cur.slices.lastJsonlEntryAtMs
  )
}

function checkD11(prev: ReplayTick, cur: ReplayTick, out: InvariantViolation[]): void {
  if (!ledgerInputsUnchanged(prev, cur)) return
  // Inputs identical ⇒ the ledger MUST return its previous object by reference.
  // A fresh object here means a stage minted a new reference on a no-op — the
  // exact defect (always-clone ghost maps, double-render-per-transition) the
  // D11 contract was written to forbid. Busts every Feed memo downstream.
  if (cur.ledger !== prev.ledger) {
    out.push({
      kind: 'd11-reference-instability',
      tick: cur.index,
      message: `tick ${cur.index} had adapter-identical inputs to tick ${prev.index} but produced a NEW RenderLedger object (D11 violation)`,
      detail: { prevTick: prev.index },
    })
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run all four invariants over a replayed recording. Returns every violation
 * found (empty array = clean). Pure — no throwing, so callers assert on the
 * array and get a readable diff.
 */
export function assertInvariants(replay: ReplayResult): InvariantViolation[] {
  const violations: InvariantViolation[] = []
  let prev: ReplayTick | null = null
  for (const tick of replay.ticks) {
    checkSingleOwner(tick, violations)
    if (prev !== null) {
      checkVanish(prev, tick, violations)
      checkD11(prev, tick, violations)
    }
    prev = tick
  }
  return violations
}
