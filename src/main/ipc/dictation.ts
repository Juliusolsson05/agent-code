import { app, ipcMain } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
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
import type { DictationDebugJournalRegistry } from '@main/dictationJournal.js'
import type { DictationDebugEventInput } from '@preload/api/types.js'
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
  // Renderer-minted debug-session UUID. Threaded in via the start-stream
  // params and used by this file's `emit(...)` helper to route every
  // CHUNK / PROVIDER / OUTCOME event into the right per-session JSONL.
  // Null only when the renderer didn't send one (legacy callers); the
  // composer hook always sends it.
  debugSessionId: string | null
  provider: DictationProvider
  apiKey: string
  mimeType?: string
  chunkCount: number
  audioBytes: number
  chunks: Buffer[]
  startedAt: number
}

const activeSessions = new Map<string, ActiveDictationSession>()

// First-8-hex-chars of SHA-256 over a chunk. Used purely as a fingerprint
// for cross-process correlation: if the same `sha8` appears in the
// renderer's CHUNK:renderer:produced event AND the main's CHUNK:main:received
// event for the same `chunkIndex`, we know IPC delivered THIS exact chunk
// (not a same-size sibling). 4 bytes is more than enough — even a 1000-chunk
// stream's collision probability is negligible for a debug fingerprint.
const sha8 = (buf: Uint8Array): string =>
  createHash('sha256').update(buf).digest('hex').slice(0, 8)

export function registerDictationIpc(deps: {
  dictationDebugJournals: DictationDebugJournalRegistry
}): void {
  // Per-session journal emitter. `debugSessionId` is null-tolerant: a session
  // that never received one (older preload, or a programmatic caller) simply
  // doesn't produce a debug file. The journal file is created lazily on the
  // first append, so a no-op here also means "no orphan empty file on disk".
  const emit = (
    debugSessionId: string | null,
    layer: DictationDebugEventInput['layer'],
    event: string,
    data?: Record<string, unknown>,
  ): void => {
    if (!debugSessionId) return
    deps.dictationDebugJournals
      .get(debugSessionId)
      .append({ layer, event, ...(data !== undefined ? { data } : {}) })
  }

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

  // Fire-and-forget journal write from the renderer. We use `ipcMain.on`
  // (not `handle`) because the renderer side is fire-and-forget; we don't
  // want to pay the promise round-trip on every chunk + every 10 Hz
  // audio-level sample. Main batches at 100 ms per file (see
  // src/main/dictationJournal.ts). Bad payloads are dropped silently —
  // the journal should never be a way to crash the main process.
  ipcMain.on(
    'dictation:debug-event',
    (_evt, debugSessionId: unknown, input: unknown) => {
      if (typeof debugSessionId !== 'string' || !debugSessionId) return
      if (!input || typeof input !== 'object') return
      const payload = input as DictationDebugEventInput
      if (typeof payload.layer !== 'string' || typeof payload.event !== 'string') return
      deps.dictationDebugJournals.get(debugSessionId).append(payload)
    },
  )

  ipcMain.handle(
    'dictation:stream-start',
    async (
      _evt,
      params: { provider: DictationProvider; mimeType?: string; debugSessionId?: string },
    ) => {
      const debugSessionId = params.debugSessionId ?? null

      if (params.provider !== 'deepgram') {
        emit(debugSessionId, 'ERROR', 'stream-start:rejected', {
          reason: 'non-deepgram-provider',
          provider: params.provider,
        })
        return { kind: 'error', message: 'Only Deepgram streaming is wired in cc-shell v1.' }
      }

      const apiKey = readDeepgramApiKey()
      if (!apiKey) {
        emit(debugSessionId, 'ERROR', 'stream-start:rejected', {
          reason: 'missing-api-key',
        })
        return {
          kind: 'error',
          message: 'Missing DEEPGRAM_API_KEY. Add it to cc-shell .env or the shell environment.',
        }
      }

      const id = randomUUID()

      activeSessions.set(id, {
        id,
        debugSessionId,
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
      emit(debugSessionId, 'IPC', 'stream-start:accepted', {
        streamId: id,
        provider: params.provider,
        mimeType: params.mimeType ?? null,
        // Never log the key itself — just confirm we found one. See the
        // privacy contract in src/main/dictationJournal.ts.
        hasApiKey: true,
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
      // CHUNK:main:received pairs with the renderer's CHUNK:renderer:produced
      // event by `sha8`. If you see a `renderer:produced` with no matching
      // `main:received`, IPC dropped the chunk. If `sha8` differs across
      // matched `chunkIndex`, the chunk got rewritten in flight (catastrophic
      // — we have never seen this).
      emit(session.debugSessionId, 'CHUNK', 'main:received', {
        streamId: params.id,
        chunkIndex: session.chunkCount - 1, // 0-based to match renderer's nextChunkIndex
        bytes: chunk.byteLength,
        sha8: sha8(chunk),
        cumulativeBytes: session.audioBytes,
      })
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
        emit(session.debugSessionId, 'OUTCOME', 'no-speech', {
          streamId: params.id,
          reason: session.chunkCount === 0 ? 'no-chunks' : 'too-short',
          audioDurationMs: params.audioDurationMs ?? null,
          chunkCount: session.chunkCount,
        })
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
        emit(session.debugSessionId, 'PROVIDER', 'batch:upload:start', {
          streamId: params.id,
          provider: session.provider,
          audioBytes: session.audioBytes,
          chunkCount: session.chunkCount,
          mimeType: session.mimeType ?? null,
        })
        const startedAt = Date.now()
        const outcome = await transcribeBatch({
          provider: session.provider,
          apiKey: session.apiKey,
          audio,
          ...(session.mimeType ? { mimeType: session.mimeType } : {}),
        })
        if (outcome.kind === 'no-speech') {
          emit(session.debugSessionId, 'OUTCOME', 'no-speech', {
            streamId: params.id,
            reason: 'provider-returned-empty',
            chunkCount: session.chunkCount,
            audioBytes: session.audioBytes,
          })
          return { kind: 'no-speech' }
        }

        const cleanText = outcome.raw.trim()
        if (!cleanText) {
          emit(session.debugSessionId, 'OUTCOME', 'no-speech', {
            streamId: params.id,
            reason: 'provider-text-empty-after-trim',
            chunkCount: session.chunkCount,
            audioBytes: session.audioBytes,
          })
          return { kind: 'no-speech' }
        }

        emit(session.debugSessionId, 'PROVIDER', 'batch:upload:ok', {
          streamId: params.id,
          sttMs: Date.now() - startedAt,
          rawTextLen: cleanText.length,
        })
        emit(session.debugSessionId, 'OUTCOME', 'success', {
          streamId: params.id,
          audioBytes: session.audioBytes,
          chunkCount: session.chunkCount,
          // Truncate at 4 KB defensively. The file is local and the
          // transcript IS user-private draft data we deliberately log,
          // but a runaway transcript shouldn't bloat one JSONL line
          // into megabytes. Most dictations are well under 500 chars.
          text: cleanText.slice(0, 4096),
        })

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
        emit(session.debugSessionId, 'ERROR', 'batch:upload:throw', {
          streamId: params.id,
          message: err instanceof Error ? err.message : String(err),
          ms: Date.now() - session.startedAt,
        })
        emit(session.debugSessionId, 'OUTCOME', 'error', {
          streamId: params.id,
          message: err instanceof Error ? err.message : 'Dictation failed.',
        })
        return {
          kind: 'error',
          message: err instanceof Error ? err.message : 'Dictation failed.',
        }
      }
    },
  )

  ipcMain.handle('dictation:stream-cancel', async (_evt, params: { id: string }) => {
    const session = activeSessions.get(params.id)
    // Emit BEFORE delete so the lookup succeeds. The journal entry then
    // gives us a terminal record even for canceled / accidental-tap
    // sessions, which is exactly the window we want visibility into.
    emit(session?.debugSessionId ?? null, 'OUTCOME', 'cancel', {
      streamId: params.id,
      chunkCount: session?.chunkCount ?? 0,
      audioBytes: session?.audioBytes ?? 0,
    })
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
