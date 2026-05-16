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
  isSpeechProviderSelectable,
  STT_PROVIDER_SUPPORT,
  transcribeAssemblyAi,
  transcribeDeepgram,
  transcribeElevenLabs,
  transcribeGladia,
  transcribeOpenAi,
  type SpeechProviderId,
  type SpeechTraceEvent,
  type SpeechTranscript,
} from 'agent-voice-dictation/speech'
import { polishTranscriptWithOpenRouter } from 'agent-voice-dictation/openrouter'

export type DictationProvider = SpeechProviderId

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
  /** Optional polish step. Agent Code will eventually feed this with
   *  per-project glossary context (the MCP feedback loop), but Phase 1
   *  keeps it as a plain on/off toggle to stay scoped. */
  polish?: { openRouterApiKey: string; model?: string }
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
  if (!isSpeechProviderSelectable(input.provider)) {
    // Mirrors the package's product-level gate: the renderer should never
    // reach this branch because Settings won't expose unselectable
    // providers, but the controller refuses to silently accept one if a
    // bad settings file does end up requesting it.
    throw new Error(`Provider "${input.provider}" is not selectable in v1`)
  }

  const transcript = await runProvider(input)
  if (!transcript.text.trim()) return { kind: 'no-speech' }

  if (!input.polish) {
    return { kind: 'success', raw: transcript.text, polished: null, transcript }
  }

  // Polish failures must NOT swallow the raw transcript — STT is the
  // irreplaceable artifact, polish is a nice-to-have. flow-electron had
  // a real bug where a transient OpenRouter outage made the user lose
  // the whole dictation; we surface raw on polish failure here.
  try {
    const result = await polishTranscriptWithOpenRouter({
      apiKey: input.polish.openRouterApiKey,
      rawTranscript: transcript.text,
      ...(input.polish.model ? { model: input.polish.model } : {}),
    })
    return { kind: 'success', raw: transcript.text, polished: result.text || null, transcript }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[dictation] polish failed; surfacing raw transcript:', err)
    return { kind: 'success', raw: transcript.text, polished: null, transcript }
  }
}

function runProvider(input: DictationBatchInput): Promise<SpeechTranscript> {
  // Provider-specific request construction stays in the package. The
  // controller's job is to route the call and forward traces — never to
  // know the shape of any one provider's request body.
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
  switch (input.provider) {
    case 'deepgram': return transcribeDeepgram({}, opts)
    case 'assemblyai': return transcribeAssemblyAi({}, opts)
    case 'openai': return transcribeOpenAi({}, opts)
    case 'gladia': return transcribeGladia({}, opts)
    case 'elevenlabs': return transcribeElevenLabs({}, opts)
  }
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

export function listSelectableProviders(): DictationProvider[] {
  // Source-of-truth for "which providers the UI should expose" is the
  // package, not Agent Code. Re-exporting through the controller (rather
  // than letting renderer code import the package directly) keeps the
  // boundary clean: renderer talks to controller, controller talks to
  // package. Future additions like an Agent Code-only "DEMO" provider
  // would slot in here without touching the package.
  return (Object.keys(STT_PROVIDER_SUPPORT) as DictationProvider[])
    .filter(id => isSpeechProviderSelectable(id))
}
