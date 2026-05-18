import { ipcRenderer } from 'electron'

import type {
  AddDebugBundleNoteParams,
  FeedDebugPersistEntry,
  ProxyEventsBundleSection,
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

  addDebugBundleNote: (params: AddDebugBundleNoteParams): Promise<void> =>
    ipcRenderer.invoke('debug:add-bundle-note', params),

  // Pull the latest proxy-events.jsonl tail + session-meta for a
  // given session into the renderer so the bundle assembler can
  // include it. Returns nulls when no proxy log was found — never
  // throws. See main/storage/proxyEventsReader.ts for caps and
  // search strategy.
  readProxyEvents: (params: {
    cwd: string
    sessionKey?: string | null
  }): Promise<ProxyEventsBundleSection> =>
    ipcRenderer.invoke('debug:read-proxy-events', params),
}
