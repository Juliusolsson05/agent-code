#!/usr/bin/env node
// Apply SYSTEMATIC triage verdicts to bundle-corpus fixtures.
//
// Runs AFTER a bless pass (AGENT_CODE_CORPUS_BLESS=1 vitest …) and upgrades
// 'untriaged' entries whose divergence matches a mechanically-checkable
// rule. Rules live here — in a reviewable script, not in heads — so a
// re-extraction can replay the whole triage instead of losing it.
//
// Verdicts assigned:
//
// equivalent-content — the SAME visible content painted via different
//   planes. The recorded visible_rows predates ingestion of the committed
//   rows for a finished turn: legacy painted the semantic turn, the
//   pipeline (which HAS those rows in its input) paints the committed rows
//   and suppresses the turn — claude's message.id === turnId makes the
//   pairing mechanical. Includes the burst's tool_result user rows (they
//   parent onto paired assistant rows). Neither renderer is wrong; the
//   fixture's input and expectation straddle an ingestion boundary.
//
// skew-ingestion-lag — extra-in-next committed rows that carry producer
//   timestamps <= the visible_rows moment but were not yet INGESTED when
//   it fired (JSONL batch drain lag). No missing-turn twin exists.
//
// legacy-bug:scaffolding-echo — extra-in-next user rows with no
//   permissionMode whose text starts '<' (environment_context /
//   command-name / local-command-stdout echoes). The legacy renderer
//   painted these as user prompts — the exact complaint in the bundle
//   notes ("spitting out commands in to the user prompts"); the #338
//   filter hiding them is the fix working.
//
// legacy-bug:prompt-not-shown — extra-in-next REAL user prompts
//   (permissionMode present) in fixtures whose note complains about
//   prompts not rendering. The pipeline painting them is the fix.
//
// extraction-gap:history-window — missing-in-next turns absent from the
//   fixture's semanticHistory input: the runtime caps history at 20 turns,
//   the recorded rows are older than the surviving window.
//
// Everything not matched stays 'untriaged' — visible debt, never silently
// blessed away.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'testing/fixtures/rendering-bundles')
const counts = {}
const bump = k => (counts[k] = (counts[k] ?? 0) + 1)

for (const file of readdirSync(DIR).filter(f => f.endsWith('.json'))) {
  const path = join(DIR, file)
  const f = JSON.parse(readFileSync(path, 'utf8'))
  const triage = f.triage ?? []
  if (triage.length === 0) continue

  const entsByUuid = new Map(f.input.entries.map(e => [e.uuid, e]))
  const hasCommittedPlane = f.meta.entriesSource !== 'none' && f.input.entries.length > 0
  // Every tool identity present in the committed plane — the codex pairing
  // key (codex suppression is unit-level: a semantic turn vanishes when all
  // its blocks are owned by committed tool/text rows).
  const committedToolIds = new Set()
  const committedTexts = new Set()
  for (const e of f.input.entries) {
    const c = e?.message?.content
    if (!Array.isArray(c)) continue
    for (const b of c) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') committedToolIds.add(b.id)
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') committedToolIds.add(b.tool_use_id)
      if (b?.type === 'text' && typeof b.text === 'string') committedTexts.add(b.text.normalize('NFKC').replace(/\s+/g, ' ').trim())
    }
  }
  const turnsById = new Map(f.input.semanticHistory.map(t => [t.turnId, t]))
  const histIds = new Set(f.input.semanticHistory.map(t => t.turnId))
  const note = (f.meta.note ?? '').toLowerCase()

  // Absolute wall-clock of the moment the legacy renderer's visible_rows
  // snapshot fired. This is the load-bearing input for skew-ingestion-lag:
  // that verdict is ONLY defensible for a committed row whose PRODUCER
  // timestamp predates this moment (the row was already on disk, merely not
  // yet drained from the JSONL ingest batch — benign lag). A row stamped
  // AFTER this moment did not exist when legacy painted, so the pipeline
  // surfacing it is a REAL divergence, not lag, and must stay untriaged as
  // visible debt. Without this bound the verdict was handed to ANY unmatched
  // assistant/user extra, mechanically blessing away genuine renderer bugs.
  //
  // Preferred source is session-start + meta.visibleRowsAtTMs (the snapshot's
  // session-relative offset), but the fixtures carry no absolute session
  // origin — visibleRowsAtTMs is a performance-clock offset with no stored T0
  // to anchor it. capturedAt (the epoch the bundle was grabbed, essentially
  // when the snapshot was taken) is the operative absolute value and upper-
  // bounds the true moment. If it is somehow missing we leave the moment NaN
  // so EVERY comparison below fails and rows stay untriaged — the safe
  // direction is to under-bless, never to bless a real extra we cannot date.
  const visibleRowsMomentMs = Number.isFinite(f.meta.capturedAt)
    ? f.meta.capturedAt
    : NaN

  const missingTurnIds = new Set(
    triage
      .filter(t => t.divergence.class === 'missing-in-next' && t.divergence.unit?.startsWith('turn:'))
      .map(t => t.divergence.unit.slice(5)),
  )
  // Assistant rows whose message.id pairs with a missing turn.
  const pairedRowUuids = new Set()
  for (const e of f.input.entries) {
    if (e?.type === 'assistant' && missingTurnIds.has(e.message?.id)) pairedRowUuids.add(e.uuid)
  }

  const textOf = e => {
    const c = e?.message?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const t = c.find(b => b?.type === 'text')
      return typeof t?.text === 'string' ? t.text : ''
    }
    return ''
  }

  let changed = false
  for (const t of triage) {
    if (t.verdict !== 'untriaged') continue
    const d = t.divergence
    const unit = d.unit ?? ''

    if (d.class === 'extra-in-next' && unit.startsWith('turn:') && !hasCommittedPlane) {
      t.verdict = 'extraction-gap'
      t.why = 'no committed plane reconstructed for this bundle (source missing or empty window); without committed ownership these turns cannot be suppressed'
      bump(t.verdict); changed = true
    } else if (d.class === 'extra-in-next' && unit.startsWith('row:')) {
      const uuid = unit.slice(4)
      const e = entsByUuid.get(uuid)
      if (!e) continue
      const parentPaired = pairedRowUuids.has(e.parentUuid)
      if (pairedRowUuids.has(uuid) || (e.type === 'user' && parentPaired)) {
        t.verdict = 'equivalent-content'
        t.why = `same content as missing turn ${e.message?.id ?? '(via parent tool_use)'} — committed rows not yet ingested at the recorded visible_rows moment; pipeline paints committed, legacy painted the semantic turn`
        bump(t.verdict); changed = true
      } else if (e.type === 'user' && e.permissionMode === undefined && textOf(e).trimStart().startsWith('<')) {
        t.verdict = 'legacy-bug:scaffolding-echo'
        t.why = 'legacy painted a scaffolding echo (<command/context> row) as a user prompt — the exact complaint in the corpus notes; the #338 synthetic-user filter hiding it is the fix'
        bump(t.verdict); changed = true
      } else if (e.type === 'user' && e.permissionMode !== undefined && /prompt/.test(note) && /show|render|regist/.test(note)) {
        t.verdict = 'legacy-bug:prompt-not-shown'
        t.why = `real user prompt legacy failed to paint — the bundle note is the bug report: "${f.meta.note}"`
        bump(t.verdict); changed = true
      } else if (e.type === 'assistant' || e.type === 'user') {
        // Gate skew-ingestion-lag on the documented timestamp window: the
        // row's producer timestamp must be <= the visible_rows moment for the
        // "existed-but-not-yet-ingested" story to hold. A row produced AFTER
        // the snapshot is a genuine extra the pipeline surfaced later, not
        // ingest lag — leaving it untriaged keeps it as visible debt instead
        // of silently blessing a real renderer divergence. NaN (missing/
        // unparseable timestamp, or missing capturedAt above) fails the
        // comparison and correctly stays untriaged.
        const rowMs = Date.parse(e.timestamp)
        if (rowMs <= visibleRowsMomentMs) {
          t.verdict = 'skew-ingestion-lag'
          t.why = 'row timestamp precedes the visible_rows moment (producer clock) but ingestion had not drained it yet; legacy could not paint what it had not seen'
          bump(t.verdict); changed = true
        }
      }
    } else if (d.class === 'missing-in-next' && unit.startsWith('row:optimistic-')) {
      // Optimistic rows live only in renderer state (runtime.entries) —
      // no transcript or rollout ever contains them, so a reconstruction
      // from disk cannot produce them regardless of provider.
      t.verdict = 'extraction-gap:optimistic-rows-renderer-local'
      t.why = 'optimistic rows exist only in renderer state; no on-disk source reconstructs them'
      bump(t.verdict); changed = true
    } else if (d.class === 'missing-in-next' && unit.startsWith('turn:')) {
      const turnId = unit.slice(5)
      const turn = turnsById.get(turnId)
      if (turn && hasCommittedPlane) {
        const blocks = Object.values(turn.blocks ?? {})
        const ids = blocks.map(b => b?.callId ?? b?.toolUseId ?? b?.itemId).filter(Boolean)
        const owned = ids.length > 0 && ids.every(id => committedToolIds.has(id))
        const textOwned =
          ids.length === 0 &&
          typeof turn.text === 'string' &&
          committedTexts.has(turn.text.normalize('NFKC').replace(/\s+/g, ' ').trim())
        if (owned || textOwned) {
          t.verdict = 'equivalent-content'
          t.why = 'unit-level suppression: every block identity (or the finalized turn text) is owned by committed rows reconstructed from the rollout — legacy painted the turn only because those rows had not been ingested at the recorded moment'
          bump(t.verdict); changed = true
          continue
        }
      }
      if (!histIds.has(turnId)) {
        t.verdict = 'extraction-gap:history-window'
        t.why = 'turn absent from the semanticHistory input — the runtime caps history at 20 turns; the recorded rows are older than the surviving window'
        bump(t.verdict); changed = true
      } else if (
        [...pairedRowUuids].some(u => entsByUuid.get(u)?.message?.id === turnId)
      ) {
        t.verdict = 'equivalent-content'
        t.why = 'suppressed in favor of its committed twin (message.id === turnId) which the pipeline paints as entry rows'
        bump(t.verdict); changed = true
      }
    }
  }
  if (changed) writeFileSync(path, JSON.stringify(f))
}
console.log(counts)
