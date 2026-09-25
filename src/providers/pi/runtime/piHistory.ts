import { PiHistoryError, readPiHistory, resolvePiSessionFile } from 'pi-terminal-headless'

import type { ProviderHistoryChunk, ProviderHistoryRequest } from '@shared/types/providerConfig.js'

// Pi history for Agent Code's history loader: pages of the ACTIVE BRANCH of
// Pi's session file, read through pi-terminal-headless.
//
// WHY not the shared backwards JSONL reader: a Pi session file is a tree —
// `/tree` keeps abandoned turns in the same file — so a line-order walk would
// show turns the user navigated away from. The package resolves the branch
// the way Pi itself does on load (from the last row), which is exactly the
// conversation the user gets back when this session resumes.
//
// Records are raw Pi rows (the shape the renderer's Pi mapper folds) and the
// page cursor is that mapper's history marker: the row's entry id.

export type PiHistoryDeps = {
  resolveFile?: (cwd: string, sessionId: string) => Promise<string | null>
}

export async function loadPiHistoryChunk(request: ProviderHistoryRequest, deps: PiHistoryDeps = {}): Promise<ProviderHistoryChunk> {
  const resolveFile = deps.resolveFile ?? ((cwd, sessionId) => resolvePiSessionFile({ env: process.env, cwd, sessionId }))
  const file = await resolveFile(request.cwd, request.providerSessionId)
  // No file is a normal Pi state, not a failure: pi writes nothing until the
  // first reply of a session completes (Stage 0 H1), so a fresh pane — or one
  // whose first turn was interrupted before any reply — genuinely has no
  // conversation yet. A file that exists but cannot be read still throws.
  if (!file) return { entries: [], hasMore: false, totalEntries: 0 }
  try {
    const page = await readPiHistory(file, { limit: request.limit, ...(request.beforeMarker ? { beforeEntryId: request.beforeMarker } : {}) })
    return {
      entries: page.rows as unknown as Record<string, unknown>[],
      hasMore: page.hasOlder,
      ...(page.hasOlder && page.rows[0] ? { oldestMarker: page.rows[0].id } : {}),
      // Counts belong to initial hydration; older windows retain its total.
      ...(request.beforeMarker ? {} : { totalEntries: page.total }),
    }
  } catch (error) {
    if (error instanceof PiHistoryError && error.code === 'not_found') return { entries: [], hasMore: false, totalEntries: 0 }
    // Electron keeps Error.message, not custom properties: the category rides in the message.
    const code = error instanceof PiHistoryError ? error.code : 'unreadable'
    throw Object.assign(new Error(`${code}: Pi history unavailable: ${(error as Error).message}`), { code })
  }
}
