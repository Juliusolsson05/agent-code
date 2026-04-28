import { app, ipcMain } from 'electron'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  deepgramStreaming,
  listSelectableProviders,
  type DictationProvider,
} from '@main/dictation/index.js'
import {
  configureDictationHotkey,
  unregisterDictationHotkey,
} from '@main/dictation/hotkey.js'
import { sendToMainWindow } from '@main/window/mainWindow.js'
import { wrapWithSttTag } from 'agent-voice-dictation'

// Opt-in chunk dump for diagnosing recorder/provider audio issues. Writes a
// `.webm` per session under Electron's app temp dir so we don't pollute
// world-readable `/tmp`. Off unless `CC_SHELL_DICTATION_DUMP=1` is set —
// keeping mic audio off-disk by default is the right default for a privacy
// surface, even if we trust the host machine. To use:
//   CC_SHELL_DICTATION_DUMP=1 npm run dev
// then the path is logged at session start and finalize.
const DICTATION_DUMP_ENABLED = process.env.CC_SHELL_DICTATION_DUMP === '1'
const dictationDumpPath = (id: string) => join(app.getPath('temp'), `cc-shell-dictation-${id}.webm`)

type ActiveDictationSession = {
  chunkCount: number
  audioBytes: number
}

const activeSessions = new Map<string, ActiveDictationSession>()

export function registerDictationIpc(): void {
  ipcMain.handle('dictation:list-providers', async () => listSelectableProviders())

  ipcMain.handle('dictation:hotkey-configure', async (_evt, params: { binding?: string }) => {
    try {
      return await configureDictationHotkey(params.binding ?? '')
    } catch (err) {
      return {
        ok: false,
        binding: params.binding ?? '',
        native: process.platform === 'darwin',
        message: err instanceof Error ? err.message : 'Could not configure dictation hotkey.',
      }
    }
  })

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
          // The provider emits one trace per audio chunk (queue + send). At
          // ~8 chunks/sec these bury every other dictation log; keep the
          // lifecycle traces (open, close, message, error, stop) at debug
          // level and gate the per-chunk firehose on
          // `CC_SHELL_DICTATION_VERBOSE=1`.
          const phase = (event as { phase?: string }).phase ?? ''
          const isPerChunk = phase === 'deepgram:chunk:queue' || phase === 'deepgram:chunk:send'
          if (isPerChunk && process.env.CC_SHELL_DICTATION_VERBOSE !== '1') return
          // eslint-disable-next-line no-console
          console.debug('[dictation:trace]', event)
        },
        onTranscript: event => {
          // Live transcript text is UI state, not provider behavior. Main keeps
          // the Deepgram protocol contained in the package client and forwards
          // only the normalized preview text to the renderer. The renderer is
          // free to paint it as a temporary draft and replace it with the final
          // STT-wrapped output when stop resolves.
          sendToMainWindow('dictation:stream-transcript', event)
        },
      })

      activeSessions.set(session.id, {
        chunkCount: 0,
        audioBytes: 0,
      })

      if (DICTATION_DUMP_ENABLED) {
        // Truncate so consecutive sessions don't concatenate into one file.
        try {
          writeFileSync(dictationDumpPath(session.id), Buffer.alloc(0))
          // eslint-disable-next-line no-console
          console.log('[dictation:dump] start', { id: session.id, file: dictationDumpPath(session.id) })
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[dictation:dump] init-failed', err)
        }
      }

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
      if (DICTATION_DUMP_ENABLED) {
        try {
          appendFileSync(dictationDumpPath(params.id), chunk)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[dictation:dump] append-failed', err)
        }
      }
      try {
        deepgramStreaming().pushChunk(params.id, chunk)
      } catch (err) {
        activeSessions.delete(params.id)
        deepgramStreaming().cancel(params.id)
        return {
          kind: 'error',
          message: err instanceof Error ? err.message : 'Dictation audio streaming failed.',
        }
      }
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
        // Audio too short to be a real dictation attempt — treat as no-speech
        // and skip provider finalization. Sending CloseStream here would
        // either get rejected as UNPARSABLE_CLIENT_MESSAGE (if the WS hasn't
        // received any audio yet) or just waste a Deepgram round-trip.
        deepgramStreaming().cancel(params.id)
        return { kind: 'no-speech' }
      }

      if (DICTATION_DUMP_ENABLED) {
        // eslint-disable-next-line no-console
        console.log('[dictation:dump] finalize', {
          id: params.id,
          file: dictationDumpPath(params.id),
          sizeBytes: session.audioBytes,
          hint: `verify with: ffprobe ${dictationDumpPath(params.id)} ; play with: ffplay -autoexit ${dictationDumpPath(params.id)}`,
        })
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

export function cleanupDictationIpcResources(): void {
  unregisterDictationHotkey()
  for (const id of activeSessions.keys()) {
    deepgramStreaming().cancel(id)
  }
  activeSessions.clear()
}

function readDeepgramApiKey(): string | null {
  const value = process.env.DEEPGRAM_API_KEY?.trim()
  return value ? value : null
}
