import { ipcRenderer } from 'electron'

import type {
  FeedDebugPersistEntry,
  SaveDebugBundleParams,
  SaveDebugBundleResult,
} from '@preload/api/types.js'

// Debug IPC surface.
//
// appendFeedDebugLog — streaming flush of FeedDebugPanel entries
// (called on a timer by useFeedDebugPersist). Main serializes
// per-session and appends to the per-session JSONL.
//
// saveDebugBundle — one-shot snapshot invoked by the "Save Debug
// Logs" palette command. Renderer assembles the file list; main
// writes a timestamped folder and returns its absolute path.

export const debugApi = {
  appendFeedDebugLog: (params: {
    sessionId: string
    entries: FeedDebugPersistEntry[]
  }): Promise<void> =>
    ipcRenderer.invoke('debug:append-feed-log', params),

  saveDebugBundle: (params: SaveDebugBundleParams): Promise<SaveDebugBundleResult> =>
    ipcRenderer.invoke('debug:save-bundle', params),
}
