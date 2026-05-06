import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  listSelectableProviders,
  transcribeBatch,
  type DictationProvider,
} from '@main/dictation/index.js'
import {
  configureDictationHotkey,
  unregisterDictationHotkey,
} from '@main/dictation/hotkey.js'
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
  id: string
  provider: DictationProvider
  apiKey: string
  mimeType?: string
  chunkCount: number
  audioBytes: number
  chunks: Buffer[]
  startedAt: number
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

      const id = randomUUID()

      activeSessions.set(id, {
        id,
        provider: params.provider,
        apiKey,
        ...(params.mimeType ? { mimeType: params.mimeType } : {}),
        chunkCount: 0,
        audioBytes: 0,
        chunks: [],
        startedAt: Date.now(),
      })

      // Temporary reliability fallback: the Deepgram websocket path sometimes
      // rejects browser MediaRecorder WebM/Opus as `UNPARSABLE_CLIENT_MESSAGE`
      // even when the full concatenated recording is valid. Until we pin down
      // exactly which websocket framing/container edge case triggers that, keep
      // the renderer IPC contract stable but transcribe the completed WebM via
      // the provider's HTTP upload API on stop. That removes live previews, but
      // it restores the primary invariant: releasing Fn should produce text
      // instead of losing the utterance.
      // eslint-disable-next-line no-console
      console.debug('[dictation:trace]', {
        provider: params.provider,
        phase: 'batch:start',
        runId: id,
        mimeType: params.mimeType ?? null,
      })

      if (DICTATION_DUMP_ENABLED) {
        // Truncate so consecutive sessions don't concatenate into one file.
        try {
          writeFileSync(dictationDumpPath(id), Buffer.alloc(0))
          // eslint-disable-next-line no-console
          console.log('[dictation:dump] start', { id, file: dictationDumpPath(id) })
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[dictation:dump] init-failed', err)
        }
      }

      return { kind: 'started', id }
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
      session.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      if (DICTATION_DUMP_ENABLED) {
        try {
          appendFileSync(dictationDumpPath(params.id), chunk)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[dictation:dump] append-failed', err)
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
        // and skip provider upload. This preserves the same user-facing
        // accidental-tap behavior the streaming path had, without spending a
        // provider request on a few encoder priming bytes.
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
        const audio = Buffer.concat(session.chunks)
        // eslint-disable-next-line no-console
        console.debug('[dictation:trace]', {
          provider: session.provider,
          phase: 'batch:upload',
          runId: params.id,
          chunkCount: session.chunkCount,
          audioBytes: session.audioBytes,
          mimeType: session.mimeType ?? null,
          ms: Date.now() - session.startedAt,
        })
        const startedAt = Date.now()
        const outcome = await transcribeBatch({
          provider: session.provider,
          apiKey: session.apiKey,
          audio,
          ...(session.mimeType ? { mimeType: session.mimeType } : {}),
        })
        if (outcome.kind === 'no-speech') return { kind: 'no-speech' }

        const cleanText = outcome.raw.trim()
        if (!cleanText) return { kind: 'no-speech' }

        return {
          kind: 'success',
          raw: cleanText,
          text: wrapWithSttTag(cleanText),
          provider: outcome.transcript.provider,
          audioBytes: session.audioBytes,
          chunkCount: session.chunkCount,
          sttMs: Date.now() - startedAt,
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
    return { kind: 'ok' }
  })
}

export function cleanupDictationIpcResources(): void {
  unregisterDictationHotkey()
  activeSessions.clear()
}

function readDeepgramApiKey(): string | null {
  const value = process.env.DEEPGRAM_API_KEY?.trim()
  return value ? value : null
}
