import { ipcRenderer } from 'electron'

import type { FeedDebugPersistEntry } from './types.js'

// Feed-debug log shipper.
//
// The renderer accumulates entries in runtime state and flushes
// batches here on a timer (see workspaceStore's persistFeedDebugLog
// effect). Main serializes per-session and appends to JSONL.

export const debugApi = {
  appendFeedDebugLog: (params: {
    sessionId: string
    entries: FeedDebugPersistEntry[]
  }): Promise<void> =>
    ipcRenderer.invoke('debug:append-feed-log', params),
}
