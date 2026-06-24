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
