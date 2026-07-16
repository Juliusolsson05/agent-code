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
// Usage: node scripts/extract-rendering-fixtures.mjs [--only <bundleId>] [--bundle <dir>] [--out <dir>]

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
const bundleIdx = args.indexOf('--bundle')
const directBundle = bundleIdx >= 0 ? args[bundleIdx + 1] : null

const MAX_ENTRIES = 80
const TOOL_RESULT_CAP = 600
const TEXT_CAP = 8000
const LIVE_PREFIX_CAP = 8000

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
function readJsonl(path) {
  const out = []
  const lines = readFileSync(path, 'utf8').split('\n')
  // Torn-tail tolerance is ONLY for the final non-empty line: a bundle saved
  // mid-write can leave a half-flushed last record, which is expected and
  // benign. A malformed line ANYWHERE ELSE is real corruption — the old blanket
  // catch silently dropped it, splicing a hole into the stream and
  // manufacturing a plausible-but-wrong fixture, so warn loudly with file:line
  // and continue best-effort rather than pretend the data was intact.
  let lastNonEmpty = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim()) {
      lastNonEmpty = i
      break
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      if (i === lastNonEmpty) {
        /* torn tail line — bundle saved mid-write; tolerated */
      } else {
        console.error(
          `extract-rendering-fixtures: malformed JSON at ${path}:${i + 1} — skipping (non-tail line, possible corruption)`,
        )
      }
    }
  }
  return out
}

// providerSessionId + cwd per bundle, from the save ledger. Some ledger
// lines are partial (note-added events) — keep the richest per path.
const ledgerByPath = new Map()
if (existsSync(LEDGER)) {
  for (const rec of readJsonl(LEDGER)) {
    if (!rec.bundlePath) continue
    const prev = ledgerByPath.get(rec.bundlePath) ?? {}
    ledgerByPath.set(rec.bundlePath, { ...prev, ...rec })
  }
}

/**
 * Pull the semantic event out of both feed-debug layouts seen in the corpus.
 *
 * WHY accept both shapes: older debug rows copied event fields directly into
 * `data`; current rows keep the channel envelope in `data` and the semantic
 * event under `data.event`. Making evidence extraction depend on only the
 * latest wrapper would silently erase the very cross-version corpus this
 * script exists to preserve.
 */
function semanticEventFromDebugRow(row) {
  if (!row || row.layer !== 'SEM') return null
  const nested = row.data?.event
  if (nested && typeof nested === 'object') return nested
  return row.data && typeof row.data === 'object' ? row.data : null
}

function declaredPatchLiteral(prefix) {
  if (typeof prefix !== 'string') return false
  // This is deliberately narrower than `prefix.includes('*** Begin Patch')`.
  // A command that greps documentation for that phrase is still a command;
  // the useful early-stream milestone is a JS variable whose quoted value has
  // already begun with the patch envelope, before `tools.apply_patch(...)`
  // necessarily exists in the stream.
  return /\b(?:const|let|var)\s+[$A-Z_a-z][$\w]*\s*=\s*["'`]\*\*\* Begin Patch(?:\\n|\n)/.test(prefix)
}

function invokedToolNames(prefix) {
  if (typeof prefix !== 'string') return []
  // Wait for the opening parenthesis. A cumulative stream passes through
  // `tools.apply`, `tools.apply_pat`, ...; treating each partial identifier as
  // a new operation would reintroduce the delta explosion milestone sampling
  // is supposed to avoid.
  return [...prefix.matchAll(/\btools\.([A-Z_a-z][$\w]*)\s*\(/g)].map(match => match[1])
}

function capLivePrefix(prefix) {
  return prefix.length > LIVE_PREFIX_CAP
    ? `${prefix.slice(0, LIVE_PREFIX_CAP)}…[truncated ${prefix.length}]`
    : prefix
}

/**
 * Preserve classifier-relevant LIVE snapshots without copying every token.
 *
 * WHY milestones rather than all tool_input_delta rows: one recent Codex
 * bundle contains 347 cumulative snapshots. Keeping them all would make a
 * tiny timing regression fixture hundreds of kilobytes, while keeping only
 * the final snapshot recreates the bug that prompted this work — the renderer
 * learns "file edit" only after the operation is already over. The milestones
 * below retain the moments at which user-visible intent becomes knowable while
 * bounding each operation to a handful of records.
 */
function extractLiveToolInputPrefixes(feedEvents, cutoffMs) {
  const operations = new Map()

  for (const row of feedEvents) {
    if (row.layer !== 'SEM' || row.kind !== 'tool_input_delta') continue
    if (typeof row.ts === 'number' && row.ts > cutoffMs) continue

    const event = semanticEventFromDebugRow(row)
    const prefix = event?.inputJsonSoFar
    if (typeof prefix !== 'string') continue

    const identity =
      event.toolUseId ??
      event.callId ??
      event.itemId ??
      `${event.turnId ?? 'turn'}:${event.blockIndex ?? 'block'}`
    const key = String(identity)
    let operation = operations.get(key)
    if (!operation) {
      operation = {
        base: {
          turnId: event.turnId ?? null,
          blockIndex: event.blockIndex ?? null,
          itemId: event.itemId ?? null,
          toolUseId: event.toolUseId ?? event.callId ?? null,
          toolName: event.toolName ?? event.name ?? null,
          source: event.source ?? null,
        },
        milestones: [],
        sawDeclaredPatch: false,
        invokedTools: new Set(),
        latest: null,
      }
      operations.set(key, operation)
    }

    const snapshot = {
      ...operation.base,
      ts: event.ts ?? row.ts ?? null,
      stage: null,
      inputLength: prefix.length,
      inputJsonSoFar: capLivePrefix(prefix),
    }

    if (operation.milestones.length === 0) {
      operation.milestones.push({ ...snapshot, stage: 'first-prefix' })
    }

    if (!operation.sawDeclaredPatch && declaredPatchLiteral(prefix)) {
      operation.sawDeclaredPatch = true
      operation.milestones.push({ ...snapshot, stage: 'declared-patch-literal' })
    }

    for (const tool of invokedToolNames(prefix)) {
      if (operation.invokedTools.has(tool)) continue
      operation.invokedTools.add(tool)
      operation.milestones.push({ ...snapshot, stage: `tool-invocation:${tool}` })
    }

    operation.latest = { ...snapshot, stage: 'latest-prefix' }
  }

  const out = []
  for (const operation of operations.values()) {
    out.push(...operation.milestones)
    const latest = operation.latest
    const lastMilestone = operation.milestones.at(-1)
    if (
      latest &&
      (!lastMilestone ||
        latest.inputLength !== lastMilestone.inputLength ||
        latest.inputJsonSoFar !== lastMilestone.inputJsonSoFar)
    ) {
      out.push(latest)
    }
  }
  return out
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

  // Read once: current bundles are large enough that reparsing feed-debug for
  // each evidence plane is measurable, and (more importantly) both expected
  // rows and live prefixes must be cut against the exact same event sequence.
  const feedEvents = readJsonl(join(dir, 'feed-debug.jsonl'))

  // ---- expected rows: last RENDER visible_rows before capture ----
  let visible = null
  for (const ev of feedEvents) {
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
  const liveToolInputPrefixes = extractLiveToolInputPrefixes(feedEvents, cutoffMs)

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
        // Presentation evidence only. The ownership corpus deliberately
        // ignores this optional field, but presentation/classifier tests can
        // replay the exact cumulative prefixes that existed BEFORE a final
        // tool object was available. This is the missing plane behind the
        // "raw const patch, then suddenly a diff after completion" bug.
        liveToolInputPrefixes,
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
const dirs = directBundle
  ? [directBundle]
  : [
      ...(existsSync(BUNDLES)
        ? readdirSync(BUNDLES)
            .filter(d => /^\d{4}-/.test(d))
            .map(d => join(BUNDLES, d))
        : []),
      ...(existsSync(ROOT_BUNDLES)
        ? readdirSync(ROOT_BUNDLES)
            .filter(d => /^\d{4}-/.test(d))
            .map(d => join(ROOT_BUNDLES, d))
        : []),
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
    // SECURITY / REDACTION GAP — READ BEFORE RUNNING ON ANYTHING NON-LOCAL:
    // Unlike the successor recordings pipeline (extract-rendering-recordings.mjs
    // → extract-recording-core.mts → rendering/replay/redact.ts), this
    // DEPRECATED bundle extractor performs NO redaction and has NO SENSITIVE_KEY
    // hard gate. It only truncates bulky payloads for SIZE (truncateEntry); the
    // fixtures it writes still contain the raw assistant/user/tool text from real
    // transcripts — api keys, tokens, and secrets included. It exists solely as
    // the predecessor to the recordings path and must ONLY be run over trusted
    // LOCAL bundles whose output stays local — never on someone else's bundle,
    // and never with intent to commit the result. A full redaction port was
    // deliberately NOT attempted here (redact.ts's gate is shaped for the
    // RecordingEvent stream, not this bundle/Entry shape, and the recordings
    // pipeline is the supported successor); if this script is ever promoted back
    // to producing checked-in fixtures, route this write through redact.ts's
    // sensitive-key gate first.
    writeFileSync(outPath, JSON.stringify(result.fixture))
    const f = result.fixture
    summary.push({
      id,
      kind: f.meta.kind,
      entries: f.input.entries.length,
      ghosts: Object.keys(f.input.ghosts).length,
      hist: f.input.semanticHistory.length,
      cur: f.input.semanticCurrent ? 1 : 0,
      livePrefixes: f.input.liveToolInputPrefixes.length,
      expectedRows: f.expected.rows.length,
      kb: Math.round(JSON.stringify(f).length / 1024),
    })
  } catch (err) {
    summary.push({ id, error: String(err).slice(0, 120) })
  }
}
// Surface per-bundle failures in the EXIT CODE, not just the printed summary.
// Previously every bundle exception was swallowed into summary[].error and the
// process still exited 0, so an automated caller (CI, a make target) saw success
// while silently emitting zero or partial fixtures. The script stays fully
// operator-usable — it still prints the whole table and finishes the loop — it
// just also reports failure so callers can detect it.
if (summary.some(s => s.error)) process.exitCode = 1
console.table(summary)
console.log(`wrote ${summary.filter(s => !s.skipped && !s.error).length}/${summary.length} fixtures to ${OUT}`)
