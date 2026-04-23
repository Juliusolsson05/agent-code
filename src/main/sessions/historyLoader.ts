import { join } from 'path'
import { readFile, readdir, stat } from 'fs/promises'

import { getMainProvider } from '@providers/registry.main.js'

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

export type HistoryChunk = {
  entries: Record<string, unknown>[]
  hasMore: boolean
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
 * Read the whole transcript file, locate `beforeMarker`, and return up
 * to `limit` entries immediately preceding it. `hasMore: true` means
 * there's still earlier history the renderer can request.
 */
export async function loadOlderHistoryChunk(
  params: HistoryChunkRequest,
): Promise<HistoryChunk> {
  const provider = getMainProvider(params.kind)
  let filePath: string | null = null

  if (params.kind === 'claude') {
    const projectDir = await provider.getProjectDir(params.cwd)
    filePath = join(projectDir, `${params.providerSessionId}.jsonl`)
  } else {
    const sessionsDir = await provider.getProjectDir(params.cwd)
    filePath = await findCodexRolloutPathByThreadId(sessionsDir, params.providerSessionId)
  }

  if (!filePath) return { entries: [], hasMore: false }

  const text = await readFile(filePath, 'utf8').catch(() => null)
  if (!text) return { entries: [], hasMore: false }

  const parsed = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      try {
        return JSON.parse(line) as Record<string, unknown>
      } catch {
        return null
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null)

  const markerOf = params.kind === 'claude'
    ? extractClaudeHistoryMarker
    : extractCodexHistoryMarker

  const anchorIndex = parsed.findIndex(entry => markerOf(entry) === params.beforeMarker)
  const cutoff = anchorIndex === -1 ? parsed.length : anchorIndex
  const older = parsed.slice(0, cutoff)
  if (older.length === 0) return { entries: [], hasMore: false }

  const start = Math.max(0, older.length - params.limit)
  return {
    entries: older.slice(start),
    hasMore: start > 0,
  }
}
