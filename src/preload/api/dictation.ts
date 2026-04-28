import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type {
  DictationHotkeyConfigureResult,
  DictationProvider,
  DictationStartResult,
  DictationStreamTranscriptEvent,
  DictationStopResult,
  Unsub,
} from '@preload/api/types.js'

export const dictationApi = {
  listDictationProviders: (): Promise<DictationProvider[]> =>
    ipcRenderer.invoke('dictation:list-providers'),

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
}
