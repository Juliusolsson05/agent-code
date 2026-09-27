// App-level dictation contract.
//
// The `agent-voice-dictation` package supports more STT providers than Agent
// Code exposes. Agent Code's main IPC accepts only Deepgram streaming today, so
// the cross-boundary app type must stay narrow. A wider union here would be a
// lie that lets renderer/preload callers compile while main rejects them at
// runtime.
export type DictationProvider = 'deepgram'

// One lifecycle vocabulary is mirrored in React state, a synchronous ref, and
// the terminal-mode overlay store. The runtime mirrors are intentional; the
// type duplication was not. Keep new phases here first so every projection has
// to acknowledge the same lifecycle transition.
export type DictationStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'error'

/** One committed dictation, as persisted by src/main/dictation/historyStore.ts. */
export type DictationHistoryEntry = {
  id: string
  /** Wall clock at the moment the transcript was committed. */
  ts: number
  /** The RAW transcript — never the `<stt>`-wrapped form. Wrapping is applied
   *  at delivery time by the live dictation path; baking today's tag format
   *  into every historical row would make the format un-changeable. */
  text: string
  /** Counted once, at write time, and never recomputed. If the counter's rule
   *  changed, recomputing on read would silently rewrite the user's history. */
  words: number
  provider: DictationProvider
  /** Hold duration reported by the renderer at stop: `Date.now() - startedAt`,
   *  where `startedAt` is stamped at MediaRecorder creation. It therefore
   *  INCLUDES ~150 ms of recorder start-up and any silence before release, and
   *  EXCLUDES upload/transcription time (it is measured before the provider
   *  call). This is the denominator for words-per-minute, which makes that stat
   *  a slight UNDERestimate of true speaking rate. Documented rather than
   *  fudged — see the plan §3.3. */
  audioDurationMs: number
  audioBytes: number
  chunkCount: number
  /** Provider round-trip for the batch upload. Diagnostics only. */
  sttMs: number
}

/** Aggregate view over the history store. */
export type DictationStats = {
  /** Monotonic. Deliberately NOT derived from the retained entries: those are a
   *  capped ring buffer, so a derived total would shrink as old rows are
   *  evicted, and "how many words have I spoken" must never go down. */
  lifetimeWords: number
  lifetimeSessions: number
  lifetimeSpokenMs: number
  /** lifetimeWords / (lifetimeSpokenMs / 60000); 0 when no measurable audio. */
  averageWpm: number
  /** How many rows the recents list actually holds right now — the honest
   *  companion to the lifetime numbers, so the UI can say "last N" truthfully. */
  retainedEntries: number
}

export type DictationHistorySnapshot = {
  stats: DictationStats
  entries: DictationHistoryEntry[]
}

// ── How a dictation ended (#243) ──────────────────────────────────────────
//
// WHY one closed union shared by main and renderer: a dictation ends in main
// (the provider answered) or in the renderer (the microphone never opened,
// the press was a tap, the pane went away), and before this each side wrote
// free text. In the owner's recorded journals, 56 of 148 sessions had NO
// terminal row at all, and all 24 recorded errors read either "Deepgram
// transcription failed" or "fetch failed", while the provider had in fact
// answered 400, 408 or nothing. A code says which of those it was, it is
// countable across journals, and the user-facing sentence is chosen from it
// (never from provider or IPC text, which can carry env values or URLs: q22).
//
// Grouped by the phase that failed, so "which phase" is the prefix.
export type DictationOutcomeReason =
  | 'success'
  | 'no-speech.too-short'
  | 'no-speech.provider-empty'
  | 'no-speech.provider-rejected-short'
  | 'cancelled.short-press'
  | 'cancelled.hidden'
  | 'cancelled.unmount'
  | 'cancelled.shutdown'
  | 'mic.unavailable'
  | 'mic.error'
  | 'mic.opened-late'
  | 'recorder.error'
  | 'recorder.no-audio'
  | 'config.missing-api-key'
  | 'config.unsupported-provider'
  | 'provider.bad-audio'
  | 'provider.auth'
  | 'provider.rate-limited'
  | 'provider.timeout'
  | 'provider.unavailable'
  | 'provider.rejected'
  | 'network'
  | 'connect.timeout'
  | 'final.timeout'
  | 'delivery.hidden-terminal'
  | 'delivery.abandoned'
  | 'unknown'

/**
 * The phase deadlines (#243), each at least 3× the longest the owner's
 * recorded journals show (148 sessions, 2026-09-27). Named here so main and
 * renderer tests read the same numbers. Recorded p50 / p95 / max, in ms:
 * - connect (stream-start request → result): 4 / 19 / 55. The unbounded part
 *   is the keychain read inside it.
 * - first audio (recorder started → first non-empty chunk): 177 / 245 / 626.
 *   A muted microphone still encodes silence, so only a capture that
 *   produces NOTHING trips this.
 * - final (batch transcription): 450 / 1,646 / 14,316.
 * Insertion has no deadline: it is a synchronous draft write (3 / 11 / 21 ms)
 * that cannot hang; its non-delivery cases carry `delivery.*` codes instead.
 */
export const DICTATION_DEADLINES_MS = {
  connect: 10_000,
  firstAudio: 2_000,
  final: 30_000,
} as const

/**
 * What a provider HTTP failure was, from its status alone (#243). The
 * recorded 400s are Deepgram's "failed to process audio" (a clip it could
 * not decode), not a request we built wrong; a failure with no status is the
 * network layer (`fetch failed`).
 */
export function classifyProviderFailure(status: number | undefined): DictationOutcomeReason {
  if (status === undefined) return 'network'
  if (status === 400) return 'provider.bad-audio'
  if (status === 401 || status === 403) return 'provider.auth'
  if (status === 408) return 'provider.timeout'
  if (status === 429) return 'provider.rate-limited'
  if (status >= 500) return 'provider.unavailable'
  return 'provider.rejected'
}

/**
 * The one sentence a user sees for a reason, or null when nothing should be
 * said (a success, a tap the user meant to abandon, a pane that is gone).
 *
 * WHY a fixed table and not the error's text (q22, q39): provider and IPC
 * errors can carry request URLs, headers or environment values, and a curated
 * prefix followed by unbounded provider text still leaks. `detail` is only
 * ever a number this module formats itself.
 */
export function dictationReasonMessage(reason: DictationOutcomeReason, detail: { micOpenMs?: number } = {}): string | null {
  switch (reason) {
    case 'success':
    case 'cancelled.short-press':
    case 'cancelled.unmount':
    case 'cancelled.shutdown':
    case 'delivery.abandoned':
      return null
    case 'no-speech.too-short':
    case 'no-speech.provider-empty':
    case 'no-speech.provider-rejected-short':
      return 'No speech detected'
    case 'cancelled.hidden':
      return 'Dictation stopped: too short to transcribe.'
    case 'mic.unavailable':
      return 'The selected microphone is unavailable. Reconnect it or choose another in Settings → Dictation → Audio Input Device.'
    case 'mic.error':
      return 'The microphone could not be opened. Check microphone access for Agent Code in System Settings → Privacy & Security.'
    case 'mic.opened-late': {
      // Bounded: a formatted number of seconds, one decimal.
      const seconds = detail.micOpenMs !== undefined && Number.isFinite(detail.micOpenMs)
        ? ` — the microphone took ${(Math.min(detail.micOpenMs, 600_000) / 1000).toFixed(1)} s to open`
        : ''
      return `Nothing was recorded${seconds}. Hold the key until the indicator shows listening.`
    }
    case 'recorder.error':
      return 'Dictation recording failed. Try again.'
    case 'recorder.no-audio':
      return 'The microphone produced no audio. Check the input device in Settings → Dictation.'
    case 'config.missing-api-key':
      return 'No Deepgram API key configured. Open Settings → Dictation and paste a key.'
    case 'config.unsupported-provider':
      return 'Only Deepgram dictation is available in this version of Agent Code.'
    case 'provider.bad-audio':
      return 'Deepgram could not process this recording. Try again.'
    case 'provider.auth':
      return 'Deepgram rejected the API key. Check it in Settings → Dictation.'
    case 'provider.rate-limited':
      return 'Deepgram is rate-limiting requests. Wait a moment and try again.'
    case 'provider.timeout':
    case 'final.timeout':
      return 'Deepgram took too long to transcribe. Try again.'
    case 'provider.unavailable':
      return 'Deepgram is unavailable right now. Try again shortly.'
    case 'provider.rejected':
      return 'Deepgram rejected the request. Try again.'
    case 'network':
      return 'Could not reach Deepgram. Check the network connection.'
    case 'connect.timeout':
      return 'Dictation could not start in time. Try again.'
    case 'delivery.hidden-terminal':
      return 'Dictation stopped: the terminal pane was hidden, so the transcript was not sent.'
    case 'unknown':
      return 'Dictation failed.'
  }
}
