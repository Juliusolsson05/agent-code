import { join } from 'path'
import { readdir, stat } from 'fs/promises'

import { getMainProvider } from '@providers/registry.main.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { streamJsonl } from '@shared/runtime/streamJsonl.js'
import { makeStringPool, internEntryFields } from '@main/sessions/internEntry.js'

const CODEX_ROLLOUT_RE =
  /^rollout-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

// Loader for older history chunks.
//
// When the user scrolls up past the bootstrapTail window in a resumed
// session, the renderer asks main for more history via
// `session:load-older-history`. This module walks the provider's
// on-disk transcript format and returns the chunk immediately before
// the `beforeMarker` the renderer already has, up to `limit` entries.
//
// The marker is provider-specific:
//   - Claude entries expose a stable `uuid`; progress-wrapped entries
//     carry the same uuid on their embedded message.
//   - Codex rollouts don't have a uuid, so we synthesize a marker from
//     timestamp + a stable field inside the payload (id / call_id /
//     type). That's good enough for chunk alignment; the renderer
//     never persists these markers across sessions.

export type HistoryChunkRequest = {
  kind: 'claude' | 'codex'
  cwd: string
  providerSessionId: string
  beforeMarker: string
  limit: number
}

export type InitialHistoryChunkRequest = Omit<HistoryChunkRequest, 'beforeMarker'>

export type HistoryChunk = {
  entries: Record<string, unknown>[]
  hasMore: boolean
  // Total count of usable JSONL records in the on-disk transcript at
  // the moment this chunk was read. Set on initial-load chunks by the
  // streaming reader's line counter. Older-history pagination omits
  // it because the renderer keeps its own running total from the
  // initial load + live appends, and counting the whole file just to
  // page one older window would reintroduce the read-everything cost
  // this loader is specifically avoiding.
  totalEntries?: number
}

function extractClaudeHistoryMarker(entry: Record<string, unknown>): string | null {
  if (typeof entry.uuid === 'string' && entry.uuid.length > 0) return entry.uuid
  if (entry.type !== 'progress') return null
  const data = entry.data as Record<string, unknown> | undefined
  const embedded = data?.message as Record<string, unknown> | undefined
  return typeof embedded?.uuid === 'string' && embedded.uuid.length > 0
    ? embedded.uuid
    : null
}

function extractCodexHistoryMarker(entry: Record<string, unknown>): string {
  const payload = entry.payload as Record<string, unknown> | undefined
  return `${String(entry.timestamp ?? '')}:${String(payload?.id ?? payload?.call_id ?? payload?.type ?? entry.type)}`
}

/**
 * Codex sessions are stored under year/month/day/<timestamp>-<threadId>.jsonl.
 * The renderer hands us only a threadId, so we walk the tree newest-
 * first (dirs sorted reverse) and pick the first file whose parsed
 * rollout UUID exactly equals the provider id.
 *
 * WHY exact parse instead of substring matching:
 *
 * Codex's rollout tree is global, not per pane or per cwd. Any helper
 * that accepts "filename contains threadId" makes transcript ownership
 * depend on an accidental substring relationship in shared storage.
 * The provider id is the UUID suffix in the structured rollout
 * filename, so older-history loading must use that exact field or
 * return nothing.
 */
async function findCodexRolloutPathByThreadId(
  sessionsDir: string,
  threadId: string,
): Promise<string | null> {
  try {
    const years = await readdir(sessionsDir)
    for (const year of years.sort().reverse()) {
      const yearDir = join(sessionsDir, year)
      const yStat = await stat(yearDir).catch(() => null)
      if (!yStat?.isDirectory()) continue
      const months = await readdir(yearDir)
      for (const month of months.sort().reverse()) {
        const monthDir = join(yearDir, month)
        const mStat = await stat(monthDir).catch(() => null)
        if (!mStat?.isDirectory()) continue
        const days = await readdir(monthDir)
        for (const day of days.sort().reverse()) {
          const dayDir = join(monthDir, day)
          const dStat = await stat(dayDir).catch(() => null)
          if (!dStat?.isDirectory()) continue
          const files = await readdir(dayDir)
          const match = files.find(f => {
            const parsed = CODEX_ROLLOUT_RE.exec(f)
            return parsed?.[2] === threadId
          })
          if (match) return join(dayDir, match)
        }
      }
    }
  } catch {
    return null
  }
  return null
}

async function resolveTranscriptPath(
  params: InitialHistoryChunkRequest,
): Promise<string | null> {
  const provider = getMainProvider(params.kind)

  if (params.kind === 'claude') {
    const projectDir = await provider.getProjectDir(params.cwd)
    return join(projectDir, `${params.providerSessionId}.jsonl`)
  }

  const sessionsDir = await provider.getProjectDir(params.cwd)
  return findCodexRolloutPathByThreadId(sessionsDir, params.providerSessionId)
}

function pushCapped<T>(items: T[], item: T, limit: number): void {
  if (limit <= 0) return
  items.push(item)
  if (items.length > limit) items.shift()
}

async function readInitialTranscriptTail(
  filePath: string,
  limit: number,
): Promise<{
  bytes: number
  parseErrors: number
  parsed: number
  entries: Record<string, unknown>[]
}> {
  const size = await stat(filePath).then(s => s.size).catch(() => 0)
  let parseErrors = 0
  let parsed = 0
  const entries: Record<string, unknown>[] = []

  // #288: one local pool per load. Every parsed line freshly allocates its
  // cwd/sessionId/role/type metadata strings; interning them against a pool
  // scoped to this single load collapses them to one instance each. The pool
  // dies with this function, so it can never become the global leak that a
  // shared pool would. See internEntry.ts for the full retainer-trace
  // evidence (cwd ×30k, role/type ×23k, sessionId ×20k per session).
  const intern = makeStringPool()

  // WHY we stream even for the initial load: the UI only needs the newest
  // `limit` records, but several crash reports came from main holding the
  // raw transcript string, split-line array, parsed-object array, and IPC
  // clone all at once. The ring buffer keeps the old totalEntries contract
  // while bounding retained JS objects to the visible bootstrap tail.
  try {
    for await (const raw of streamJsonl<Record<string, unknown>>(filePath)) {
      if (raw === null) {
        parseErrors++
        continue
      }
      parsed++
      internEntryFields(raw, intern)
      pushCapped(entries, raw, limit)
    }
  } catch {
    return { bytes: size, parseErrors, parsed, entries: [] }
  }

  return { bytes: size, parseErrors, parsed, entries }
}

async function readOlderTranscriptWindow(
  filePath: string,
  params: HistoryChunkRequest,
): Promise<{
  bytes: number
  parseErrors: number
  parsed: number
  foundMarker: boolean
  hasMore: boolean
  entries: Record<string, unknown>[]
}> {
  const size = await stat(filePath).then(s => s.size).catch(() => 0)
  const markerOf = params.kind === 'claude'
    ? extractClaudeHistoryMarker
    : extractCodexHistoryMarker
  let parseErrors = 0
  let parsed = 0
  let countBeforeCutoff = 0
  let foundMarker = false
  const entries: Record<string, unknown>[] = []

  // #288: local pool for this older-window load (same rationale as the
  // initial-tail reader above — intern the duplicated metadata, drop the
  // pool when the load returns). Note we intern only the entries we keep,
  // i.e. those before the marker; the ones we scan-and-discard while
  // hunting the anchor never need it.
  const intern = makeStringPool()

  // WHY the older-page loader stops at the anchor marker instead of parsing
  // the whole transcript: older pagination is frequently driven by scrolling,
  // and the previous implementation reread a 100+ MB file for every page.
  // We still preserve the historical fallback where a missing marker means
  // "page from the file tail" because live append races can leave the renderer
  // asking before a marker that no longer exists in the durable transcript.
  try {
    for await (const raw of streamJsonl<Record<string, unknown>>(filePath)) {
      if (raw === null) {
        parseErrors++
        continue
      }
      parsed++
      if (markerOf(raw) === params.beforeMarker) {
        foundMarker = true
        break
      }
      countBeforeCutoff++
      internEntryFields(raw, intern)
      pushCapped(entries, raw, params.limit)
    }
  } catch {
    return {
      bytes: size,
      parseErrors,
      parsed,
      foundMarker: false,
      hasMore: false,
      entries: [],
    }
  }

  return {
    bytes: size,
    parseErrors,
    parsed,
    foundMarker,
    hasMore: countBeforeCutoff > params.limit,
    entries,
  }
}

/**
 * Read the whole transcript file, locate `beforeMarker`, and return up
 * to `limit` entries immediately preceding it. `hasMore: true` means
 * there's still earlier history the renderer can request.
 */
export async function loadOlderHistoryChunk(
  params: HistoryChunkRequest,
): Promise<HistoryChunk> {
  const span = performanceService.span('historyLoader.loadOlderChunk', {
    kind: params.kind,
    limit: params.limit,
    hasBeforeMarker: params.beforeMarker.length > 0,
  })

  try {
    const filePath = await resolveTranscriptPath(params)

    if (!filePath) {
      span.end({ result: 'missing-file' })
      return { entries: [], hasMore: false }
    }

    const parsed = await readOlderTranscriptWindow(filePath, params)
    if (parsed.entries.length === 0) {
      span.end({ result: 'empty-or-read-failed', filePath })
      return { entries: [], hasMore: false }
    }

    span.end({
      result: 'loaded',
      bytes: parsed.bytes,
      parsed: parsed.parsed,
      parseErrors: parsed.parseErrors,
      foundMarker: parsed.foundMarker,
      returned: parsed.entries.length,
      hasMore: parsed.hasMore,
    })
    return {
      entries: parsed.entries,
      hasMore: parsed.hasMore,
    }
  } catch (err) {
    span.fail(err)
    throw err
  }
}

/**
 * Return the newest durable transcript records without waiting for the
 * provider process to replay them over IPC. The renderer still folds
 * this through its normal feed-entry mapper and uuid set, so live
 * replay can arrive before or after this read without double-rendering
 * entries that carry stable ids.
 */
export async function loadInitialHistoryChunk(
  params: InitialHistoryChunkRequest,
): Promise<HistoryChunk> {
  const span = performanceService.span('historyLoader.loadInitialChunk', {
    kind: params.kind,
    limit: params.limit,
  })

  try {
    const filePath = await resolveTranscriptPath(params)
    if (!filePath) {
      span.end({ result: 'missing-file' })
      return { entries: [], hasMore: false, totalEntries: 0 }
    }
    const parsed = await readInitialTranscriptTail(filePath, params.limit)
    if (parsed.entries.length === 0) {
      span.end({ result: 'empty-or-read-failed', filePath })
      return { entries: [], hasMore: false, totalEntries: 0 }
    }

    span.end({
      result: 'loaded',
      bytes: parsed.bytes,
      parsed: parsed.parsed,
      parseErrors: parsed.parseErrors,
      returned: parsed.entries.length,
      hasMore: parsed.parsed > params.limit,
    })
    return {
      entries: parsed.entries,
      hasMore: parsed.parsed > params.limit,
      totalEntries: parsed.parsed,
    }
  } catch (err) {
    span.fail(err)
    throw err
  }
}
