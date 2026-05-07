import { ipcMain } from 'electron'

import {
  queueFeedDebugAppend,
  type FeedDebugPersistEntry,
} from '@main/storage/feedDebugLog.js'
import {
  saveDebugBundle,
  type SaveDebugBundleParams,
  type SaveDebugBundleResult,
} from '@main/storage/debugBundle.js'
import {
  readProxyEventsForBundle,
  type ProxyEventsBundleSection,
} from '@main/storage/proxyEventsReader.js'

// Debug-panel IPC.
//
// Two endpoints:
//   - debug:append-feed-log — streaming, fire-and-forget batches from
//     the FeedDebugPanel flush timer. Serialized per-session in the
//     storage module; this handler just validates shape and forwards.
//   - debug:save-bundle — one-shot, user-triggered from the "Save
//     Debug Logs" command palette entry. Renderer assembles the bundle
//     (state + feed-debug + proxy semantic + html raw/clean) and we
//     persist it as a timestamped folder under DEBUG_BUNDLE_DIR. The
//     return value is the absolute path so the renderer can display
//     it and copy it to the clipboard.

export function registerDebugIpc(): void {
  ipcMain.handle(
    'debug:append-feed-log',
    async (
      _evt,
      params: { sessionId: string; entries: FeedDebugPersistEntry[] },
    ) => {
      if (!params?.sessionId || !Array.isArray(params.entries) || params.entries.length === 0) {
        return
      }
      await queueFeedDebugAppend(params.sessionId, params.entries)
    },
  )

  ipcMain.handle(
    'debug:save-bundle',
    async (_evt, params: SaveDebugBundleParams): Promise<SaveDebugBundleResult> => {
      // Let errors propagate. The renderer catches and shows a
      // `save failed: <msg>` toast — the user triggered this
      // explicitly, so silent failure is strictly worse than a
      // surfaced one.
      return saveDebugBundle(params)
    },
  )

  // Read the latest proxy-events.jsonl for a session (Claude or
  // Codex; they share the on-disk layout). Used by saveDebugBundle
  // in the renderer to pull the wire-level capture into the bundle
  // without forcing the whole bundle assembler into the main
  // process. Errors are swallowed inside readProxyEventsForBundle —
  // a missing or unreadable proxy log must never break bundle
  // save.
  ipcMain.handle(
    'debug:read-proxy-events',
    async (
      _evt,
      params: { cwd: string; sessionKey?: string | null },
    ): Promise<ProxyEventsBundleSection> => {
      if (!params || typeof params.cwd !== 'string') {
        return { proxyEvents: null, runDir: null, sessionMeta: null }
      }
      return readProxyEventsForBundle({
        cwd: params.cwd,
        sessionKey: params.sessionKey ?? null,
      })
    },
  )
}
