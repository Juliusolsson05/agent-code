import { ipcMain } from 'electron'

import {
  deepgramStreaming,
  listSelectableProviders,
  type DictationProvider,
} from '@main/dictation/index.js'
import { wrapWithSttTag } from 'agent-voice-dictation'

type ActiveDictationSession = {
  chunkCount: number
  audioBytes: number
}

const activeSessions = new Map<string, ActiveDictationSession>()

export function registerDictationIpc(): void {
  ipcMain.handle('dictation:list-providers', async () => listSelectableProviders())

  ipcMain.handle(
    'dictation:stream-start',
    async (_evt, params: { provider: DictationProvider; mimeType?: string }) => {
      if (params.provider !== 'deepgram') {
        return { kind: 'error', message: 'Only Deepgram streaming is wired in cc-shell v1.' }
      }

      const apiKey = readDeepgramApiKey()
      if (!apiKey) {
        return {
          kind: 'error',
          message: 'Missing DEEPGRAM_API_KEY. Add it to cc-shell .env or the shell environment.',
        }
      }

      const session = deepgramStreaming().start({
        apiKey,
        ...(params.mimeType ? { mimeType: params.mimeType } : {}),
        onTrace: event => {
          // Keep traces in main where provider protocol lives. This gives us
          // the same forensic trail as flow-electron without leaking raw
          // WebSocket/provider details into the renderer composer surface.
          // eslint-disable-next-line no-console
          console.debug('[dictation:trace]', event)
        },
      })

      activeSessions.set(session.id, {
        chunkCount: 0,
        audioBytes: 0,
      })

      return { kind: 'started', id: session.id }
    },
  )

  ipcMain.handle(
    'dictation:stream-chunk',
    async (_evt, params: { id: string; chunk: ArrayBuffer }) => {
      const session = activeSessions.get(params.id)
      if (!session) return { kind: 'ignored' }

      const chunk = new Uint8Array(params.chunk)
      if (chunk.byteLength <= 1) return { kind: 'ignored' }

      session.chunkCount += 1
      session.audioBytes += chunk.byteLength
      deepgramStreaming().pushChunk(params.id, chunk)
      return { kind: 'ok' }
    },
  )

  ipcMain.handle(
    'dictation:stream-stop',
    async (_evt, params: { id: string; audioDurationMs?: number }) => {
      const session = activeSessions.get(params.id)
      if (!session) {
        return { kind: 'error', message: 'Dictation session is no longer active.' }
      }
      activeSessions.delete(params.id)

      if (session.chunkCount === 0 || (params.audioDurationMs ?? 0) < 300) {
        deepgramStreaming().cancel(params.id)
        return { kind: 'no-speech' }
      }

      try {
        const transcript = await deepgramStreaming().stop(params.id)
        const cleanText = transcript.text.trim()
        if (!cleanText) return { kind: 'no-speech' }

        return {
          kind: 'success',
          raw: cleanText,
          text: wrapWithSttTag(cleanText),
          provider: transcript.provider,
          audioBytes: transcript.audioBytes,
          chunkCount: transcript.chunkCount,
          sttMs: transcript.sttDoneAt - transcript.startedAt,
        }
      } catch (err) {
        return {
          kind: 'error',
          message: err instanceof Error ? err.message : 'Dictation failed.',
        }
      }
    },
  )

  ipcMain.handle('dictation:stream-cancel', async (_evt, params: { id: string }) => {
    activeSessions.delete(params.id)
    deepgramStreaming().cancel(params.id)
    return { kind: 'ok' }
  })
}

function readDeepgramApiKey(): string | null {
  const value = process.env.DEEPGRAM_API_KEY?.trim()
  return value ? value : null
}
