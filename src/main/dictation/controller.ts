// Phase 1: minimal main-process dictation controller for Agent Code.
//
// Purpose of this file is narrow on purpose. It proves Agent Code can call
// `agent-voice-dictation` from its main process and shape the outputs into
// the discriminated-union outcome type the renderer will eventually consume.
// No IPC handlers, no global hotkey, no UI yet — those land in Phase 2 with
// the composer-integrated pill. Keeping this file backend-only means the
// integration shape (provider selection, key resolution, trace forwarding,
// outcome typing) is settled BEFORE we have to make UI commitments that
// would otherwise lock us into the wrong contract.
//
// Why mirror flow-electron's controller shape? Two consumers of the same
// package converging on the same orchestration vocabulary makes it easier
// to spot drift later — if the package gains a new primitive (say,
// per-session diarisation), both hosts adopt it the same way. Every place
// where Agent Code's needs *intentionally* differ from flow-electron's gets
// a comment explaining why.

import {
  createDeepgramStreamingProvider,
  transcribeDeepgram,
  type SpeechTraceEvent,
  type SpeechTranscript,
} from 'agent-voice-dictation/speech'
import type { DictationProvider } from '@shared/types/dictation.js'

export type { DictationProvider }

export type DictationBatchInput = {
  provider: DictationProvider
  apiKey: string
  audio: ArrayBuffer | Uint8Array
  mimeType?: string
  /** ISO 639-1 / BCP-47 short code. v1 is English-only by product
   *  decision (see agent-voice-dictation settings store comment) — leaving
   *  this configurable here keeps the option available for Agent Code to
   *  expose multilingual dictation later without a controller refactor. */
  language?: string
  onTrace?: (event: SpeechTraceEvent) => void
}

// Discriminated union, same shape as the cleanup we landed on the
// agent-voice-dictation app side (PR #1, "treat empty transcripts as a
// normal outcome"). Adopted here from the start so Agent Code never has the
// "no speech detected = thrown exception spamming the terminal" phase
// flow-electron had to refactor out of.
export type DictationBatchOutcome =
  | { kind: 'success'; raw: string; polished: string | null; transcript: SpeechTranscript }
  | { kind: 'no-speech' }

export async function transcribeBatch(input: DictationBatchInput): Promise<DictationBatchOutcome> {
  if (input.provider !== 'deepgram') {
    // Main IPC rejects non-Deepgram before sessions are created, but this
    // controller is also a programmatic boundary. Keep the runtime guard so a
    // stale settings file or future test helper cannot accidentally revive the
    // dead multi-provider path the app no longer ships.
    throw new Error(`Provider "${input.provider}" is not wired in Agent Code v1`)
  }

  const transcript = await runProvider(input)
  if (!transcript.text.trim()) return { kind: 'no-speech' }

  return { kind: 'success', raw: transcript.text, polished: null, transcript }
}

function runProvider(input: DictationBatchInput): Promise<SpeechTranscript> {
  // Agent Code's product surface is Deepgram-only. The package still owns the
  // broader STT provider matrix for other hosts, but keeping those imports here
  // made this app look more configurable than it is and shipped dead provider
  // code into the main bundle. This thin wrapper preserves the request-shaping
  // boundary without pretending there are live app-side alternatives.
  const audio = {
    data: input.audio,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
  }
  const opts = {
    apiKey: input.apiKey,
    audio,
    ...(input.language ? { language: input.language } : {}),
    ...(input.onTrace ? { onTrace: input.onTrace } : {}),
  }
  return transcribeDeepgram({}, opts)
}

// Singleton streaming provider. The package's createDeepgramStreamingProvider
// is intentionally session-keyed: one instance manages many concurrent
// sessions identified by id. We construct it lazily on first use because
// the Agent Code main process should not pay the WebSocket-helper cost
// during boot — most users will never trigger dictation.
let deepgramStreamingSingleton: ReturnType<typeof createDeepgramStreamingProvider> | null = null

export function deepgramStreaming(): ReturnType<typeof createDeepgramStreamingProvider> {
  if (!deepgramStreamingSingleton) {
    deepgramStreamingSingleton = createDeepgramStreamingProvider()
  }
  return deepgramStreamingSingleton
}
