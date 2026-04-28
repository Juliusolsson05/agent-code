import { ipcRenderer } from 'electron'

import type {
  DictationProvider,
  DictationStartResult,
  DictationStopResult,
} from '@preload/api/types.js'

export const dictationApi = {
  listDictationProviders: (): Promise<DictationProvider[]> =>
    ipcRenderer.invoke('dictation:list-providers'),

  startDictationStream: (params: {
    provider: DictationProvider
    mimeType?: string
  }): Promise<DictationStartResult> =>
    ipcRenderer.invoke('dictation:stream-start', params),

  pushDictationChunk: (params: {
    id: string
    chunk: ArrayBuffer
  }): Promise<{ kind: 'ok' | 'ignored' }> =>
    ipcRenderer.invoke('dictation:stream-chunk', params),

  stopDictationStream: (params: {
    id: string
    audioDurationMs?: number
  }): Promise<DictationStopResult> =>
    ipcRenderer.invoke('dictation:stream-stop', params),

  cancelDictationStream: (params: { id: string }): Promise<{ kind: 'ok' }> =>
    ipcRenderer.invoke('dictation:stream-cancel', params),
}
