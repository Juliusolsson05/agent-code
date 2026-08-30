import { app, ipcMain } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { deepgramStreaming, transcribeBatch } from '@main/dictation/index.js'
import type { DictationProvider } from '@main/dictation/index.js'
import {
  configureDictationHotkey,
  unregisterDictationHotkey,
} from '@main/dictation/hotkey.js'
import {
  getDeepgramApiKeyStatus,
  readDeepgramApiKeyForRuntime,
  setDeepgramApiKey,
} from '@main/dictation/apiKeyStore.js'
import {
  appendEntry,
  clearEntries,
  deleteEntry,
  readHistory,
  resetTotals,
} from '@main/dictation/historyStore.js'
import { sendToWindow, windowIdFor } from '@main/window/windowRegistry.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import type { DictationDebugJournalRegistry } from '@main/dictationJournal.js'
import type { DictationDebugEventInput } from '@preload/api/types.js'
import { sha8FromDigestBytes } from '@shared/code/sha8.js'
import { wrapWithSttTag } from 'agent-voice-dictation/composer'
import type { SpeechTraceEvent } from 'agent-voice-dictation/speech'

// Opt-in chunk dump for diagnosing recorder/provider audio issues. Writes a
// `.webm` per session under Electron's app temp dir so we don't pollute
// world-readable `/tmp`. Off unless `AGENT_CODE_DICTATION_DUMP=1` is set —
// keeping mic audio off-disk by default is the right default for a privacy
// surface, even if we trust the host machine. To use:
//   AGENT_CODE_DICTATION_DUMP=1 npm run dev
// then the path is logged at session start and finalize.
const DICTATION_DUMP_ENABLED = process.env.AGENT_CODE_DICTATION_DUMP === '1'
const dictationDumpPath = (id: string) => join(app.getPath('temp'), `agent-code-dictation-${id}.webm`)

type ActiveDictationSession = {
  id: string
  // Renderer-minted debug-session UUID. Threaded in via the start-stream
  // params and used by this file's `emit(...)` helper to route every
  // CHUNK / PROVIDER / OUTCOME event into the right per-session JSONL.
  // Null only when the renderer didn't send one (older callers); the
  // composer hook always sends it.
  debugSessionId: string | null
  provider: DictationProvider
  apiKey: string
  mimeType?: string
  chunkCount: number
  audioBytes: number
  chunks: Buffer[]
  streamingId: string | null
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
  sha8FromDigestBytes(createHash('sha256').update(buf).digest())

// Unpack everything a provider failure knows, not just `.message`.
//
// WHY this exists: the package throws `SpeechProviderError` carrying `status`
// (HTTP code) and `details` (the response body), but every journal site used to
// log only `err.message` — which for Deepgram is the constant string
// "Deepgram transcription failed". Two recorded failures could not be diagnosed
// from the journal at all because the actual rejection reason was thrown away
// at the logging boundary. A durable log that records a constant is not a log.
//
// Structural checks rather than `instanceof`: SpeechProviderError lives in the
// agent-voice-dictation submodule, and importing a class across that boundary
// purely to satisfy an instanceof — which also breaks if two copies of the
// module ever load — buys nothing over reading the fields defensively.
function describeProviderError(err: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    message: err instanceof Error ? err.message : String(err),
  }
  if (!err || typeof err !== 'object') return base
  const candidate = err as { status?: unknown; details?: unknown; provider?: unknown }
  if (typeof candidate.status === 'number') base.status = candidate.status
  if (typeof candidate.provider === 'string') base.provider = candidate.provider
  if (candidate.details !== undefined) {
    // Truncated: `details` is a raw response body and a provider having a bad
    // day can return an HTML error page. The first 2 KB always contains the
    // machine-readable reason if there is one.
    const text =
      typeof candidate.details === 'string'
        ? candidate.details
        : safeJsonStringify(candidate.details)
    if (text) base.details = text.slice(0, 2048)
  }
  return base
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

export function registerDictationIpc(deps: {
  dictationDebugJournals: DictationDebugJournalRegistry
  // App-run journal for hotkey-helper degrade breadcrumbs (#495 A4). The
  // dictation debug journals above are per-recording-session and lazily
  // created by the renderer; a hotkey registration failure happens BEFORE
  // any recording session exists, so it must land in the always-on app-run
  // journal or it lands nowhere durable.
  appRunJournal: AppRunJournal
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

  // Voice-dictation API key management. Reads never return the raw key —
// only a masked hint — so IPC transcripts and dev tooling never leak the
// credential even when logging is verbose. Writes go through safeStorage
// via apiKeyStore.ts; see that file for the full storage rationale.
  ipcMain.handle('dictation:api-key-status', async () => getDeepgramApiKeyStatus())
  ipcMain.handle('dictation:api-key-set', async (_evt, params: { key?: string }) => {
    try {
      const status = await setDeepgramApiKey(params.key ?? '')
      return { ok: true, status }
    } catch (err) {
      // Same pattern as hotkey-configure: bubble the reason back to the
      // renderer so the settings row can render an inline error instead of
      // pretending success.
      return {
        ok: false,
        message:
          err instanceof Error ? err.message : 'Could not store the Deepgram API key.',
      }
    }
  })

  // Dictation history. Every mutating handler returns the FRESH snapshot rather
  // than void, so the renderer updates in one round-trip instead of firing a
  // follow-up list call — same shape as `dictation:api-key-set` returning the
  // new status.
  //
  // Known gap, stated so nobody assumes otherwise: this makes a renderer's OWN
  // mutations consistent, not the panel as a whole. A dictation committed in
  // another pane appends a row that no open Settings panel hears about — there
  // is no `dictation:history-changed` push today, so the list is stale until it
  // remounts. Reads are serialised against in-flight appends (see readHistory),
  // so what it shows is always a real past state, never a torn one.
  ipcMain.handle('dictation:history-list', async () => readHistory())
  ipcMain.handle('dictation:history-delete', async (_evt, params: { id?: string }) => {
    if (!params?.id) return readHistory()
    return deleteEntry(params.id)
  })
  ipcMain.handle('dictation:history-clear', async () => clearEntries())
  ipcMain.handle('dictation:history-reset-totals', async () => resetTotals())

  ipcMain.handle('dictation:hotkey-configure', async (_evt, params: { binding?: string }) => {
    try {
      const result = await configureDictationHotkey(params.binding ?? '')
      if (!result.ok && result.message) {
        // Durable breadcrumb for the graceful degrade (#495 A4). The
        // renderer also receives `result.message`, but its console.warn is
        // ephemeral; the journal entry is what lets a future session
        // answer "why did dictation stop working on this machine?" from a
        // debug bundle. Severity 'warn', not 'error': the app keeps
        // running fine, one feature is unavailable.
        deps.appRunJournal.record({
          area: 'dictation.hotkey',
          name: 'dictation.hotkey.unavailable',
          severity: 'warn',
          data: { binding: result.binding, message: result.message },
        })
      }
      return result
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
      evt,
      params: { provider: DictationProvider; mimeType?: string; debugSessionId?: string },
    ) => {
      const debugSessionId = params.debugSessionId ?? null
      // WHY the originating window is captured here instead of resolved at
      // delivery time: interim transcript words must land in the composer the
      // user is dictating INTO. Focus can move to another window mid-utterance
      // (a click, a notification, ⌘`), and resolving late would start typing a
      // half-finished sentence into a different workspace's composer.
      const originWindowId = windowIdFor(evt.sender)

      if (params.provider !== 'deepgram') {
        emit(debugSessionId, 'ERROR', 'stream-start:rejected', {
          reason: 'non-deepgram-provider',
          provider: params.provider,
        })
        return { kind: 'error', message: 'Only Deepgram streaming is wired in Agent Code v1.' }
      }

      const apiKey = await readDeepgramApiKeyForRuntime()
      if (!apiKey) {
        emit(debugSessionId, 'ERROR', 'stream-start:rejected', {
          reason: 'missing-api-key',
        })
        return {
          kind: 'error',
          message:
            'No Deepgram API key configured. Open Settings → Voice Dictation and paste a key.',
        }
      }

      const id = randomUUID()
      let streamingId: string | null = null

      try {
        const streaming = deepgramStreaming().start({
          apiKey,
          ...(params.mimeType ? { mimeType: params.mimeType } : {}),
          onTrace: (event: SpeechTraceEvent) => {
            emit(debugSessionId, 'PROVIDER', event.phase, {
              streamId: id,
              streamingId,
              ...event,
            })
          },
          onTranscript: event => {
            // Agent Code keeps the batch upload as the final authority because
            // the WebM/Opus websocket path has had provider-side parser
            // failures. Streaming is still valuable as a preview side-channel:
            // if it emits interim text, the composer can paint live words; if
            // it fails, the final release path below still has every chunk and
            // uploads the complete WebM over HTTP.
            sendToWindow(originWindowId, 'dictation:stream-transcript', {
              id,
              text: event.text,
              isFinal: event.isFinal,
              source: event.source,
            })
          },
        })
        streamingId = streaming.id
        emit(debugSessionId, 'PROVIDER', 'streaming:start:ok', {
          streamId: id,
          streamingId,
          provider: params.provider,
          mimeType: params.mimeType ?? null,
        })
      } catch (err) {
        emit(debugSessionId, 'ERROR', 'streaming:start:throw', {
          streamId: id,
          message: err instanceof Error ? err.message : String(err),
        })
      }

      activeSessions.set(id, {
        id,
        debugSessionId,
        provider: params.provider,
        apiKey,
        ...(params.mimeType ? { mimeType: params.mimeType } : {}),
        chunkCount: 0,
        audioBytes: 0,
        chunks: [],
        streamingId,
        startedAt: Date.now(),
      })

      // The batch upload remains the source of truth, but we now also open the
      // package-owned streaming provider above for live previews. This split is
      // intentional: Deepgram streaming can fail independently, and that must
      // never make the release-key path lose the utterance.
      // eslint-disable-next-line no-console
      console.debug('[dictation:trace]', {
        provider: params.provider,
        phase: streamingId ? 'hybrid:start' : 'batch:start',
        runId: id,
        streamingId,
        mimeType: params.mimeType ?? null,
      })
      emit(debugSessionId, 'IPC', 'stream-start:accepted', {
        streamId: id,
        provider: params.provider,
        mimeType: params.mimeType ?? null,
        streamingId,
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
      // `=== 0`, never `<= 1`. This is the second half of the same bug the
      // renderer's dataavailable handler carried: an audio chunk is a slice of
      // one continuous muxed byte stream with no per-chunk framing, so dropping
      // a 1-byte chunk deletes a byte out of the middle of the WebM container
      // and Deepgram rejects the whole recording as "corrupt or unsupported
      // data". A cold encoder emits exactly such a 1-byte first chunk.
      //
      // This guard is defense-in-depth behind the renderer's, and it has to
      // agree with it — a stricter main-side threshold would resurrect the bug
      // even after the renderer was fixed, and the failure would look identical
      // (transcription silently empty on the first press of an app run). See
      // useComposerDictation.ts's dataavailable handler for the full evidence.
      if (chunk.byteLength === 0) return { kind: 'ignored' }

      session.chunkCount += 1
      session.audioBytes += chunk.byteLength
      session.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      if (session.streamingId) {
        try {
          deepgramStreaming().pushChunk(session.streamingId, chunk)
        } catch (err) {
          // Streaming is best-effort preview. Keep recording and keep the
          // batch buffer intact; otherwise a websocket-side failure would
          // regress the primary behavior the fallback was added to protect.
          emit(session.debugSessionId, 'ERROR', 'streaming:chunk:throw', {
            streamId: params.id,
            streamingId: session.streamingId,
            message: err instanceof Error ? err.message : String(err),
          })
          deepgramStreaming().cancel(session.streamingId)
          session.streamingId = null
        }
      }
      // CHUNK:main:received pairs with the renderer's CHUNK:renderer:produced
      // event by `sha8`. If you see a `renderer:produced` with no matching
      // `main:received`, IPC dropped the chunk. If `sha8` differs across
      // matched `chunkIndex`, the chunk got rewritten in flight (catastrophic
      // — we have never seen this).
      emit(session.debugSessionId, 'CHUNK', 'main:received', {
        streamId: params.id,
        // 0-based, and it matches the renderer's `chunkIndex` because BOTH
        // sides now count only chunks that were actually forwarded — the
        // renderer increments `nextChunkIndex` after its own empty-blob guard.
        // If the two ever diverge, every sha8 pairing in the journal shifts by
        // one and reads as "IPC rewrote the chunks in flight", which is the
        // catastrophic-and-never-seen diagnosis warned about above. The journal
        // is the instrument that found the cold-start bug; keeping its keying
        // honest is what makes the next investigation possible.
        chunkIndex: session.chunkCount - 1,
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
        if (session.streamingId) deepgramStreaming().cancel(session.streamingId)
        return { kind: 'no-speech' }
      }

      const streamingId = session.streamingId
      const streamingStop = streamingId
        ? deepgramStreaming().stop(streamingId).catch(err => {
            emit(session.debugSessionId, 'ERROR', 'streaming:stop:throw', {
              streamId: params.id,
              streamingId,
              ...describeProviderError(err),
              ms: Date.now() - session.startedAt,
            })
            return null
          })
        : Promise.resolve(null)

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
        void streamingStop
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
        // Record the dictation in the durable history store — deliberately
        // NOT awaited. The user is watching a "transcribing…" pill right now;
        // putting a disk write between the provider answering and the composer
        // filling would make dictation feel slower than it is, in exchange for
        // bookkeeping they cannot see. The store serialises its own writes, and
        // `flushHistoryWrites()` on before-quit covers the dictate-then-⌘Q race.
        //
        // Raw text, never the <stt>-wrapped form: the wrapper is a delivery
        // concern for the LIVE prompt, and baking today's tag format into every
        // historical row would make the format un-changeable.
        //
        // A failed write must never fail the dictation. The transcript reaching
        // the composer is the product; this row is bookkeeping.
        void appendEntry({
          text: cleanText,
          provider: session.provider,
          audioDurationMs: params.audioDurationMs ?? 0,
          audioBytes: session.audioBytes,
          chunkCount: session.chunkCount,
          sttMs: Date.now() - startedAt,
        }).catch(err => {
          emit(session.debugSessionId, 'ERROR', 'history:append:throw', {
            streamId: params.id,
            message: err instanceof Error ? err.message : String(err),
          })
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
          ...describeProviderError(err),
          ms: Date.now() - session.startedAt,
        })

        // A sub-second accidental press that the provider rejects is not an
        // error the user needs to see — it is the "no speech" case arriving by
        // a different route. The streaming path already gets this right: it
        // returns empty text cleanly for these clips. Only the HTTP batch path
        // throws, and surfacing a red "Dictation failed" toast for a half-second
        // stray press trains the user to ignore the toast that matters.
        //
        // Deliberately narrow, and gated on the ERROR SHAPE as well as the clip
        // size. Size alone is not enough — the reclassification band works out
        // to roughly audioDurationMs ∈ [300, 600) once the pre-flight `< 300`
        // guard above is accounted for, and that band contains ordinary short
        // push-to-talk commands ("yes", "next", "commit it"), not just
        // accidental brushes. Keying on size alone therefore turned a wrong API
        // key into "No speech detected" on every short command, and the user
        // would conclude the microphone was broken while the real cause (a 401)
        // sat only in the journal.
        //
        // So: only a request the provider rejected as MALFORMED can be
        // downgraded. Auth (401/403), rate limits (429), provider outages (5xx),
        // and network-layer throws (no status at all) always surface as errors,
        // because those are exactly the failures the user must be told about.
        //
        // NOT fixed by widening the `audioDurationMs < 300` pre-flight guard
        // above: that duration is measured from `recording.startedAt`, stamped
        // at recorder creation, so it already includes ~150ms of startup before
        // any audio exists. Raising it would start discarding real short
        // dictations, which is a worse failure than a stray toast.
        const status = (err as { status?: unknown } | null)?.status
        const providerRejectedTheClip = typeof status === 'number' && status >= 400 && status < 500
          && status !== 401 && status !== 403 && status !== 429
        const looksLikeStrayTap =
          providerRejectedTheClip
          && session.chunkCount <= 3
          && (params.audioDurationMs ?? 0) < 1000
        if (looksLikeStrayTap) {
          emit(session.debugSessionId, 'OUTCOME', 'no-speech', {
            streamId: params.id,
            reason: 'too-short-provider-rejected',
            chunkCount: session.chunkCount,
            audioBytes: session.audioBytes,
            audioDurationMs: params.audioDurationMs ?? null,
          })
          return { kind: 'no-speech' }
        }

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

// WHY the old readDeepgramApiKey() env-only helper is gone:
//
// Prior to safeStorage backing, packaged Agent Code silently failed
// dictation because Finder-launched apps do not inherit a shell PATH or
// exported env. Settings-configured keys now live in
// src/main/dictation/apiKeyStore.ts; env is honoured first only as a dev
// override. All call sites go through readDeepgramApiKeyForRuntime.
