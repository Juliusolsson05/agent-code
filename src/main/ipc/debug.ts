import { ipcMain } from 'electron'

import {
  queueFeedDebugAppend,
  type FeedDebugPersistEntry,
} from '../storage/feedDebugLog.js'

// Debug-panel IPC.
//
// The renderer's FeedDebugPanel accumulates entries in memory and
// flushes batches here on a timer. We serialize per-session in the
// storage module; this handler just validates the payload shape and
// forwards.

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
}
