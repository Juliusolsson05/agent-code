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
  const histIds = new Set(f.input.semanticHistory.map(t => t.turnId))
  const note = (f.meta.note ?? '').toLowerCase()

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

    if (d.class === 'extra-in-next' && unit.startsWith('row:')) {
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
        t.verdict = 'skew-ingestion-lag'
        t.why = 'row timestamp precedes the visible_rows moment (producer clock) but ingestion had not drained it yet; legacy could not paint what it had not seen'
        bump(t.verdict); changed = true
      }
    } else if (d.class === 'missing-in-next' && unit.startsWith('turn:')) {
      const turnId = unit.slice(5)
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
