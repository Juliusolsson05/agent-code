import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type {
  DictationApiKeyStatus,
  DictationApiKeySetResult,
  DictationHistorySnapshot,
  DictationHotkeyConfigureResult,
  DictationProvider,
  DictationStartResult,
  DictationStreamTranscriptEvent,
  DictationStopResult,
  Unsub,
} from '@preload/api/types.js'

export const dictationApi = {
  getDictationApiKeyStatus: (): Promise<DictationApiKeyStatus> =>
    ipcRenderer.invoke('dictation:api-key-status'),

  setDictationApiKey: (params: { key: string }): Promise<DictationApiKeySetResult> =>
    ipcRenderer.invoke('dictation:api-key-set', params),

  configureDictationHotkey: (params: {
    binding: string
  }): Promise<DictationHotkeyConfigureResult> =>
    ipcRenderer.invoke('dictation:hotkey-configure', params),

  onDictationHotkeyDown: (handler: (payload: { binding: string }) => void): Unsub =>
    subscribe('dictation:hotkey-down', handler),

  onDictationHotkeyUp: (handler: (payload: { binding: string }) => void): Unsub =>
    subscribe('dictation:hotkey-up', handler),

  onDictationStreamTranscript: (handler: (payload: DictationStreamTranscriptEvent) => void): Unsub =>
    subscribe('dictation:stream-transcript', handler),

  startDictationStream: (params: {
    provider: DictationProvider
    mimeType?: string
    // Renderer-minted debug-session UUID. Threaded to main so the
    // [dictation:stream-*] handlers can emit IPC/CHUNK/PROVIDER events
    // into the per-session journal (see preload/api/types.ts →
    // DictationDebugLayer). Optional in the type so a hypothetical
    // caller that doesn't care about debugging still compiles; the
    // composer hook always sends it.
    debugSessionId?: string
  }): Promise<DictationStartResult> =>
    ipcRenderer.invoke('dictation:stream-start', params),

  pushDictationChunk: (params: {
    id: string
    chunk: ArrayBuffer
  }): Promise<{ kind: 'ok' | 'ignored' } | { kind: 'error'; message: string }> =>
    ipcRenderer.invoke('dictation:stream-chunk', params),

  stopDictationStream: (params: {
    id: string
    audioDurationMs?: number
  }): Promise<DictationStopResult> =>
    ipcRenderer.invoke('dictation:stream-stop', params),

  cancelDictationStream: (params: { id: string }): Promise<{ kind: 'ok' }> =>
    ipcRenderer.invoke('dictation:stream-cancel', params),

  // History. Every mutation resolves with the fresh snapshot, so callers never
  // need a follow-up list call and can never render a stale list between the
  // mutation and a refetch.
  listDictationHistory: (): Promise<DictationHistorySnapshot> =>
    ipcRenderer.invoke('dictation:history-list'),

  deleteDictationHistoryEntry: (params: { id: string }): Promise<DictationHistorySnapshot> =>
    ipcRenderer.invoke('dictation:history-delete', params),

  clearDictationHistory: (): Promise<DictationHistorySnapshot> =>
    ipcRenderer.invoke('dictation:history-clear'),

  resetDictationStats: (): Promise<DictationHistorySnapshot> =>
    ipcRenderer.invoke('dictation:history-reset-totals'),
}
