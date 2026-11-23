// Antigravity history pages, and the `antigravity://session/<id>` locator.
//
// WHY the live session's rows first: a renderer reload (and the phone's
// backfill) adopts the still-running AntigravitySession in main and rebuilds
// the feed from the provider's history source. agy's conversation store is a
// private SQLite schema Agent Code does not read (antigravity-acp-headless
// paths.ts), and the rows the live session already emitted are exactly what
// the renderer folded the first time, under the same keys, so serving them
// back makes a reload look like nothing happened and later live rows dedupe
// by key. Same pattern and reasoning as Hermes (hermesHistory.ts).
//
// WHY a replay fallback: a pane that is NOT live (the catalog's preview, MCP
// read_agent on a closed agent) has no rows in memory. agy's own session/load
// replays the conversation; a short-lived `agy acp` does that with no model
// call, and its rows use the same ordinal keys a live pane would.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readAntigravityConversation, type AntigravityRow } from 'antigravity-acp-headless'

import type { ProviderHistoryChunk, ProviderHistoryRequest } from '@shared/types/providerConfig.js'

export type AntigravityHistorySource = {
  rows: () => ReadonlyArray<AntigravityRow>
}

const live = new Map<string, AntigravityHistorySource>()

export function registerAntigravityHistory(sessionId: string, source: AntigravityHistorySource): () => void {
  live.set(sessionId, source)
  return () => {
    if (live.get(sessionId) === source) live.delete(sessionId)
  }
}

export function liveAntigravityRows(sessionId: string): ReadonlyArray<AntigravityRow> | null {
  return live.get(sessionId)?.rows() ?? null
}

export type AntigravityReplayDeps = {
  binary?: string
  spawn?: (binary: string, args: string[], options: { cwd: string }) => ChildProcessWithoutNullStreams
}

/** Replay a conversation through a short-lived `agy acp` (no model call). */
export async function replayAntigravityConversation(sessionId: string, cwd: string, deps: AntigravityReplayDeps = {}): Promise<AntigravityRow[]> {
  const binary = deps.binary ?? 'agy'
  const child = (deps.spawn ?? ((bin, args, options) => spawn(bin, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })))(binary, ['acp'], { cwd })
  child.stderr.on('data', () => {})
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  try {
    return await readAntigravityConversation(child.stdout, child.stdin, { sessionId, cwd })
  } finally {
    child.kill()
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))])
  }
}

export async function loadAntigravityHistoryChunk(request: ProviderHistoryRequest, deps: AntigravityReplayDeps = {}): Promise<ProviderHistoryChunk> {
  let rows = liveAntigravityRows(request.providerSessionId)
  if (!rows) {
    try {
      rows = await replayAntigravityConversation(request.providerSessionId, request.cwd, deps)
    } catch (error) {
      // Electron keeps Error.message, not custom properties: the category rides in the message.
      throw Object.assign(new Error(`unreadable: Antigravity history unavailable: ${(error as Error).message}`), { code: 'unreadable' })
    }
  }
  // Paging by the mapper's marker (= the row key): everything strictly older.
  const end = request.beforeMarker ? rows.findIndex(row => row.key === request.beforeMarker) : rows.length
  const upto = end < 0 ? 0 : end
  const start = Math.max(0, upto - Math.max(0, request.limit))
  const page = rows.slice(start, upto)
  return {
    entries: page.map(row => ({ ...row }) as unknown as Record<string, unknown>),
    hasMore: start > 0,
    ...(request.beforeMarker ? {} : { totalEntries: rows.length }),
    ...(start > 0 && page[0] ? { oldestMarker: page[0].key } : {}),
  }
}

/** The pane's transcript identity; also what AntigravitySession emits as `file`. */
export function antigravityTranscriptLocator(sessionId: string): string {
  return `antigravity://session/${sessionId}`
}

export function parseAntigravityTranscriptLocator(locator: string): string | null {
  return /^antigravity:\/\/session\/([A-Za-z0-9_-]+)$/.exec(locator)?.[1] ?? null
}
