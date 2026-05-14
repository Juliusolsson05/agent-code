import { join } from 'path'
import { readFile, readdir, stat } from 'fs/promises'

import { getMainProvider } from '@providers/registry.main.js'
import { performanceService } from '@main/performance/PerformanceService.js'

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
  // the moment this chunk was read. Set on initial-load chunks (where
  // we parse the whole file anyway to slice the tail), omitted on
  // older-history pagination (which intentionally walks just the
  // window the renderer asked for and doesn't have the full count
  // handy — the renderer keeps its own running total from the
  // initial load + live appends).
  //
  // WHY it lives on the chunk and not as a separate IPC: the renderer
  // already round-trips through this shape, and `readTranscriptEntries`
  // already pays the cost of parsing every line to pick the tail
  // window. Adding an explicit count IPC would re-read the file for
  // no benefit. If/when this loader moves to a streaming reader (per
  // PR #87's streamJsonl utility) the field becomes a streamed line
  // counter — same contract, cheaper implementation.
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
 * first (dirs sorted reverse) and pick the first file whose name
 * contains the id. Cheap for any reasonable session age; if we ever
 * need a full scan we'll index at boot.
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
          const match = files.find(f => f.includes(threadId) && f.endsWith('.jsonl'))
          if (match) return join(dayDir, match)
        }
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Resolve and parse the provider's durable transcript file. Both the
 * initial-tail loader and older-history pagination use this path so
 * provider storage quirks stay in one place; renderer-side mapping is
 * still provider-specific because those mapped feed rows are UI state.
 */
async function readTranscriptEntries(
  params: InitialHistoryChunkRequest,
): Promise<{
  filePath: string | null
  textLength: number
  parseErrors: number
  entries: Record<string, unknown>[]
}> {
  const provider = getMainProvider(params.kind)
  let filePath: string | null = null

  if (params.kind === 'claude') {
    const projectDir = await provider.getProjectDir(params.cwd)
    filePath = join(projectDir, `${params.providerSessionId}.jsonl`)
  } else {
    const sessionsDir = await provider.getProjectDir(params.cwd)
    filePath = await findCodexRolloutPathByThreadId(sessionsDir, params.providerSessionId)
  }

  if (!filePath) {
    return { filePath: null, textLength: 0, parseErrors: 0, entries: [] }
  }

  const text = await readFile(filePath, 'utf8').catch(() => null)
  if (!text) {
    return { filePath, textLength: 0, parseErrors: 0, entries: [] }
  }

  let parseErrors = 0
  const entries = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        parseErrors++
        return null
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null)

  return { filePath, textLength: text.length, parseErrors, entries }
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
    const parsed = await readTranscriptEntries(params)

    if (!parsed.filePath) {
      span.end({ result: 'missing-file' })
      return { entries: [], hasMore: false }
    }

    if (parsed.entries.length === 0) {
      span.end({ result: 'empty-or-read-failed', filePath: parsed.filePath })
      return { entries: [], hasMore: false }
    }

    const markerOf = params.kind === 'claude'
      ? extractClaudeHistoryMarker
      : extractCodexHistoryMarker

    const anchorIndex = parsed.entries.findIndex(entry => markerOf(entry) === params.beforeMarker)
    const cutoff = anchorIndex === -1 ? parsed.entries.length : anchorIndex
    const older = parsed.entries.slice(0, cutoff)
    if (older.length === 0) {
      span.end({
        result: 'no-older',
        bytes: parsed.textLength,
        parsed: parsed.entries.length,
        parseErrors: parsed.parseErrors,
      })
      return { entries: [], hasMore: false }
    }

    const start = Math.max(0, older.length - params.limit)
    const entries = older.slice(start)
    span.end({
      result: 'loaded',
      bytes: parsed.textLength,
      parsed: parsed.entries.length,
      parseErrors: parsed.parseErrors,
      returned: entries.length,
      hasMore: start > 0,
    })
    return {
      entries,
      hasMore: start > 0,
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
    const parsed = await readTranscriptEntries(params)
    if (!parsed.filePath) {
      span.end({ result: 'missing-file' })
      return { entries: [], hasMore: false, totalEntries: 0 }
    }
    if (parsed.entries.length === 0) {
      span.end({ result: 'empty-or-read-failed', filePath: parsed.filePath })
      return { entries: [], hasMore: false, totalEntries: 0 }
    }

    const start = Math.max(0, parsed.entries.length - params.limit)
    const entries = parsed.entries.slice(start)
    span.end({
      result: 'loaded',
      bytes: parsed.textLength,
      parsed: parsed.entries.length,
      parseErrors: parsed.parseErrors,
      returned: entries.length,
      hasMore: start > 0,
    })
    // totalEntries is the count of every usable JSONL record in the
    // file at this moment — what the renderer uses as the denominator
    // for "you are at entry X of Y". This is the same value `parsed`
    // already produced; we just stop throwing it away after slicing.
    return { entries, hasMore: start > 0, totalEntries: parsed.entries.length }
  } catch (err) {
    span.fail(err)
    throw err
  }
}
