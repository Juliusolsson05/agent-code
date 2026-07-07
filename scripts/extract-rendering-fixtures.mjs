#!/usr/bin/env node
// Extract rendering-pipeline fixtures from saved debug bundles.
//
// The debug-bundle corpus (~/.config/agent-code/debug-bundles/manual) is a
// catalog of real rendering failures: each bundle was saved at the moment a
// bug was visible, with a note saying what looked wrong. This script
// reconstructs the pipeline INPUT (runtime slices) and the legacy OUTPUT
// (the rows the old renderer actually painted) for each bundle and emits
// them as fixture JSON under testing/fixtures/rendering-bundles/.
//
// Reconstruction sources (see the bundle-format spec in the rewrite plan
// research; state-snapshot deliberately drops the heavy planes):
//   entries   → provider transcript JSONL on disk, resolved through
//               saved-debug-bundles.jsonl (providerSessionId + cwd),
//               entries with timestamp <= capturedAt
//   semantic  → proxy-semantic.json (full SemanticRuntimeState dump)
//   ghosts    → ghost journal (userData/ghost-logs/<sessionId>.ghost.jsonl)
//               folded by uuid, last record with updatedAt <= capturedAt
//   scalars   → state-snapshot.json (streamPhase, pendingTool*,
//               lastJsonlEntryAt, queuedMessages)
//   expected  → last RENDER visible_rows event in feed-debug.jsonl
//               (the legacy renderer's ACTUAL painted rows — recorded
//               ground truth, not recomputed)
//
// Size discipline: entries are capped to the newest MAX_ENTRIES before
// capture, expected rows older than the kept window are trimmed, and
// bulky tool_result payloads are truncated (they never participate in
// ownership keys — only assistant/user text does).
//
// Usage: node scripts/extract-rendering-fixtures.mjs [--only <bundleId>] [--out <dir>]

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const BUNDLES = join(homedir(), '.config/agent-code/debug-bundles/manual')
const ROOT_BUNDLES = join(homedir(), '.config/agent-code/debug-bundles')
const GHOST_LOGS = join(homedir(), 'Library/Application Support/agent-code/ghost-logs')
const LEDGER = join(BUNDLES, 'saved-debug-bundles.jsonl')

const args = process.argv.slice(2)
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null
const outIdx = args.indexOf('--out')
const OUT = outIdx >= 0 ? args[outIdx + 1] : join(process.cwd(), 'testing/fixtures/rendering-bundles')

const MAX_ENTRIES = 80
const TOOL_RESULT_CAP = 600
const TEXT_CAP = 8000

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
function readJsonl(path) {
  const out = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* torn tail line — bundle saved mid-write; skip */
    }
  }
  return out
}

// providerSessionId + cwd per bundle, from the save ledger. Some ledger
// lines are partial (note-added events) — keep the richest per path.
const ledgerByPath = new Map()
for (const rec of readJsonl(LEDGER)) {
  if (!rec.bundlePath) continue
  const prev = ledgerByPath.get(rec.bundlePath) ?? {}
  ledgerByPath.set(rec.bundlePath, { ...prev, ...rec })
}

function transcriptPathFor(cwd, providerSessionId, kind) {
  if (!providerSessionId) return null
  if (kind === 'claude') {
    const slug = ('-' + cwd.replaceAll('/', '-')).replace(/^--/, '-')
    const p = join(homedir(), '.claude/projects', slug.replace(/^-/, '-'), `${providerSessionId}.jsonl`)
    // Claude Code's project slug replaces '/' AND '.' with '-'; try both.
    const candidates = [
      p,
      join(homedir(), '.claude/projects', cwd.replaceAll('/', '-').replaceAll('.', '-'), `${providerSessionId}.jsonl`),
      join(homedir(), '.claude/projects', '-' + cwd.slice(1).replaceAll('/', '-').replaceAll('.', '-'), `${providerSessionId}.jsonl`),
    ]
    return candidates.find(existsSync) ?? null
  }
  if (kind === 'codex') {
    // Rollouts live under ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl.
    // Walk the date tree; the providerSessionId is embedded in the filename.
    const root = join(homedir(), '.codex/sessions')
    if (!existsSync(root)) return null
    const stack = [root]
    while (stack.length) {
      const dir = stack.pop()
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, name.name)
        if (name.isDirectory()) stack.push(full)
        else if (name.name.includes(providerSessionId) && name.name.endsWith('.jsonl')) return full
      }
    }
    return null
  }
  return null
}

/**
 * Codex entries come from the REAL in-app mapper
 * (mapCodexRolloutToFeedEntries) executed via tsx — reimplementing ~500
 * lines of provider mapping in this script would mint a second mapper
 * that drifts, and the recorded visible_rows keys use the app mapper's
 * uuid scheme, so only the real mapper reproduces comparable ids.
 */
function codexEntriesFor(rolloutPath, cutoffMs) {
  const out = execFileSync(
    'npx',
    ['tsx', '--tsconfig', 'tsconfig.web.json', 'scripts/extract-codex-entries.mts', rolloutPath, String(cutoffMs)],
    { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return JSON.parse(out)
}

function truncateEntry(entry) {
  const msg = entry.message
  if (!msg || !Array.isArray(msg.content)) return entry
  const content = msg.content.map(block => {
    if (block?.type === 'tool_result') {
      const c = block.content
      if (typeof c === 'string' && c.length > TOOL_RESULT_CAP) {
        return { ...block, content: c.slice(0, TOOL_RESULT_CAP) + `…[truncated ${c.length}]` }
      }
      if (Array.isArray(c)) {
        return {
          ...block,
          content: c.map(part =>
            typeof part?.text === 'string' && part.text.length > TOOL_RESULT_CAP
              ? { ...part, text: part.text.slice(0, TOOL_RESULT_CAP) + `…[truncated ${part.text.length}]` }
              : part,
          ),
        }
      }
      return block
    }
    if (typeof block?.text === 'string' && block.text.length > TEXT_CAP) {
      return { ...block, text: block.text.slice(0, TEXT_CAP) + `…[truncated ${block.text.length}]` }
    }
    return block
  })
  return { ...entry, message: { ...msg, content } }
}

function extractBundle(dir) {
  const id = basename(dir)
  const manifest = readJson(join(dir, 'manifest.json'))
  const note = existsSync(join(dir, 'note.json')) ? readJson(join(dir, 'note.json')).note : null
  const snapshot = readJson(join(dir, 'state-snapshot.json'))
  const semantic = readJson(join(dir, 'proxy-semantic.json'))
  const capturedAt = manifest.capturedAt

  // ---- expected rows: last RENDER visible_rows before capture ----
  let visible = null
  for (const ev of readJsonl(join(dir, 'feed-debug.jsonl'))) {
    if (ev.layer === 'RENDER' && ev.kind === 'visible_rows' && ev.data?.rows) visible = ev
  }
  if (!visible) return { id, skipped: 'no visible_rows event in feed-debug window' }
  // Align input planes to the EXPECTED moment: the visible_rows event's own
  // epoch ts. Cutting at capturedAt instead produced whole divergence
  // classes that were pure skew (entries landing between the last RENDER
  // emission and the save click showed as extra-in-next; their semantic
  // twins as missing-in-next). Semantic state cannot be rewound (it is a
  // capture-time dump), so residual current-turn skew is triaged per
  // fixture instead.
  const cutoffMs = typeof visible.ts === 'number' ? visible.ts : capturedAt

  // ---- entries from transcript ----
  const ledger = ledgerByPath.get(dir) ?? {}
  const tPath = transcriptPathFor(ledger.cwd ?? manifest.projectDir ?? '', ledger.providerSessionId, manifest.kind)
  let entries = []
  let entriesSource = 'none'
  if (tPath) {
    entriesSource = tPath
    if (manifest.kind === 'codex') {
      entries = codexEntriesFor(tPath, cutoffMs)
    } else {
      // Seen-uuid dedupe mirroring the runtime's ingest (seenUuidsRef,
      // workspace/hook/refs.ts): compaction rewrites the transcript window
      // and the same uuid can appear twice in the file; the runtime ingests
      // each uuid once (first wins), so replaying without the dedupe lands
      // duplicate rows the real feed never had — the 14-02-05 a8ad1ebb
      // order-mismatch was exactly this artifact, not a renderer difference.
      const seenUuids = new Set()
      for (const rec of readJsonl(tPath)) {
        const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : rec.timestamp
        if (typeof ts !== 'number' || ts > cutoffMs) continue
        if (typeof rec.uuid === 'string') {
          if (seenUuids.has(rec.uuid)) continue
          seenUuids.add(rec.uuid)
        }
        entries.push(rec)
      }
    }
    entries = entries.slice(-MAX_ENTRIES).map(truncateEntry)
  }

  // ---- ghosts from journal ----
  const ghostPath = join(GHOST_LOGS, `${manifest.sessionId}.ghost.jsonl`)
  const ghosts = {}
  if (existsSync(ghostPath)) {
    for (const rec of readJsonl(ghostPath)) {
      if (rec?._atp?.updatedAt != null && rec._atp.updatedAt <= cutoffMs) {
        ghosts[rec.uuid] = rec
      }
    }
  }

  // ---- expected rows, trimmed to the kept entry window ----
  const keptUuids = new Set(entries.map(e => e.uuid).filter(Boolean))
  const rows = visible.data.rows
    .map(r => ({ key: r.key, slot: r.slot, itemType: r.itemType ?? r.slot }))
    .filter(r => {
      if (r.slot !== 'entry') return true
      const uuid = r.key.replace(/^entry:/, '')
      // Ghost/optimistic rows fold into entries in the legacy path but are
      // NOT in the transcript — keep them (they come from ghosts/semantic).
      if (uuid.startsWith('g-') || uuid.startsWith('optimistic-')) return true
      return entriesSource === 'none' ? true : keptUuids.has(uuid)
    })

  return {
    id,
    fixture: {
      meta: {
        bundleId: id,
        note,
        kind: manifest.kind,
        sessionId: manifest.sessionId,
        capturedAt,
        capturedAtIso: manifest.capturedAtIso,
        entriesSource,
        entriesTruncatedTo: entries.length,
        visibleRowsAtTMs: visible.tMs ?? null,
      },
      input: {
        provider: manifest.kind,
        // (history trimmed below when entries were truncated)
        streamPhase: snapshot.streamPhase,
        streamPhasePendingToolName: snapshot.streamPhasePendingToolName ?? null,
        streamPhasePendingToolUseId: snapshot.streamPhasePendingToolUseId ?? null,
        lastJsonlEntryAt: snapshot.lastJsonlEntryAt ?? null,
        queuedMessages: snapshot.queuedMessages ?? [],
        entries,
        semanticCurrent: semantic.currentTurn ?? null,
        semanticHistory: (semantic.history ?? []).filter(t => {
          // Drop history turns older than the kept entry window — their
          // committed owners were truncated away, so keeping them would
          // manufacture suppression misses that never happened in the app.
          if (entriesSource === 'none' || entries.length === 0) return true
          const windowStart = Date.parse(entries[0]?.timestamp ?? 0) || 0
          const turnEnd = t?.endedAt ?? t?.startedAt ?? 0
          return turnEnd >= windowStart
        }),
        ghosts,
      },
      expected: {
        rows,
        semanticTurnId: visible.data.semanticTurnId ?? null,
        semanticHistoryTurnIds: visible.data.semanticHistoryTurnIds ?? [],
        streamPhase: visible.data.streamPhase ?? null,
      },
      // Triage state: [] means "new pipeline must match the recorded legacy
      // rows exactly at the shadow-unit grain". Divergences discovered by
      // the corpus test get triaged HERE with class+unit+verdict+why —
      // verdict 'legacy-bug' keeps the divergence (asserted explicitly),
      // 'new-bug' means fix the pipeline, 'skew' means input/expected were
      // captured ticks apart (documented, tolerated).
      triage: [],
    },
  }
}

mkdirSync(OUT, { recursive: true })
const dirs = [
  ...readdirSync(BUNDLES)
    .filter(d => /^\d{4}-/.test(d))
    .map(d => join(BUNDLES, d)),
  ...readdirSync(ROOT_BUNDLES)
    .filter(d => /^\d{4}-/.test(d))
    .map(d => join(ROOT_BUNDLES, d)),
]
const summary = []
for (const dir of dirs) {
  const id = basename(dir)
  if (only && id !== only) continue
  try {
    const result = extractBundle(dir)
    if (result.skipped) {
      summary.push({ id, skipped: result.skipped })
      continue
    }
    const outPath = join(OUT, `${id}.json`)
    writeFileSync(outPath, JSON.stringify(result.fixture))
    const f = result.fixture
    summary.push({
      id,
      kind: f.meta.kind,
      entries: f.input.entries.length,
      ghosts: Object.keys(f.input.ghosts).length,
      hist: f.input.semanticHistory.length,
      cur: f.input.semanticCurrent ? 1 : 0,
      expectedRows: f.expected.rows.length,
      kb: Math.round(JSON.stringify(f).length / 1024),
    })
  } catch (err) {
    summary.push({ id, error: String(err).slice(0, 120) })
  }
}
console.table(summary)
console.log(`wrote ${summary.filter(s => !s.skipped && !s.error).length}/${summary.length} fixtures to ${OUT}`)
