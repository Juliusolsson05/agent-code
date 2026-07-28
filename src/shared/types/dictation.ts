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
