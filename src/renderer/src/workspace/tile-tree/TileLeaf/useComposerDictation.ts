import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'

import type { DictationProviderId } from '@renderer/app-state/settings/types'
import { keyboardEventMatchesBinding } from '@renderer/lib/hotkeyBinding'
import {
  registerDictationTarget,
  type DictationTargetHandle,
} from '@renderer/workspace/tile-tree/TileLeaf/dictationHotkeyRegistry'
import type { DictationDebugLayer } from '@preload/api/types'

type DictationStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'error'

type QueuedAudioChunk = {
  index: number
  chunk: ArrayBuffer
}

type ActiveRecording = {
  id: string | null
  // Renderer-minted debug-session UUID. Lives for the whole press (idle →
  // starting → recording → stopping → idle) so every event from device
  // pick to final commit lands in the same JSONL. NOT the Deepgram stream
  // id — see preload/api/types.ts → DictationDebugLayer for the WHY.
  debugSessionId: string
  recorder: MediaRecorder
  stream: MediaStream
  mimeType: string | null
  startedAt: number
  baseInput: string
  previewText: string
  queuedChunks: QueuedAudioChunk[]
  pendingPushes: Promise<unknown>[]
  chunkChain: Promise<void>
  nextChunkIndex: number
  streamStartPromise: Promise<string | null> | null
  streamStartTimer: number | null
  discarded: boolean
}

const EMPTY_LEVELS = [0, 0, 0, 0, 0, 0, 0]
const MIN_HOLD_TO_TRANSCRIBE_MS = 180

// 8-char SHA-256 prefix over a chunk payload. Used purely as a fingerprint
// for cross-process collision detection: if the same chunk hash appears in
// the renderer's CHUNK:renderer:produced event AND the main's
// CHUNK:main:received event for a given chunkIndex, we know IPC delivered
// THIS exact chunk (not a different one with the same byte count).
// `crypto.subtle.digest` is async but tiny — we await it inside the chunk
// chain, which is already serialised, so it adds no extra ordering risk.
async function sha8(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  const hex: string[] = []
  const view = new Uint8Array(digest, 0, 4)
  for (const b of view) hex.push(b.toString(16).padStart(2, '0'))
  return hex.join('')
}

// Why we pre-warm the mic before the user ever presses Fn:
// On macOS, the FIRST `getUserMedia({audio: true})` call after the app
// boots is dramatically slower than subsequent calls — sometimes 4+
// seconds while AVCaptureSession spins up, queries devices, and validates
// permission. The trace that tracked this down had a Fn press at T=17s, a
// release at T=21.4s, and `lifecycle: 'starting'` the whole time: start()
// was just sitting inside `await getUserMedia`. By the time it returned,
// the user had already given up. Pre-warming once at boot moves that cost
// off the user-visible critical path so the first real press is instant.
//
// We deliberately stop the tracks immediately after the warm-up. Keeping
// the stream alive would solve the cold-start completely but leaves the
// macOS mic indicator on for the entire app session, which is creepy.
// Stopping them still primes Chromium's device-cache enough that the next
// `getUserMedia` resolves in under ~200 ms instead of seconds.
let prewarmFired = false
const prewarmMicrophone = async (): Promise<void> => {
  if (prewarmFired) return
  prewarmFired = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
  } catch {
    // Pre-warm failure is not fatal — the regular start() path will get its
    // own permission prompt / error path if needed. Swallow here so a
    // permission-denied at boot doesn't surface as an uncaught rejection.
  }
}

// -----------------------------------------------------------------------------
// Force the built-in Mac microphone for dictation.
// -----------------------------------------------------------------------------
//
// WHY this exists, in one paragraph:
//   `getUserMedia({ audio: true })` returns whatever the OS thinks the
//   "default" audio input is. On macOS, pairing AirPods (or any other
//   Bluetooth headset) makes them the default input device, and Chromium
//   inside Electron then opens that device in HFP/SCO mode. HFP/SCO is
//   the low-quality two-way profile, and on a non-trivial number of
//   user setups it produces a stream that delivers ZERO audio samples —
//   the MediaRecorder still emits a valid WebM/Opus container, the
//   AnalyserNode in audioLevels.ts reads all zeros, the level meter
//   stays flat, the recorded blob ships to Deepgram, and Deepgram
//   transcribes silence as the empty string. The user sees: recording
//   pill works, sine-wave indicator dead, transcription comes back
//   empty. None of the recent fixes (chunk ordering, batch fallback,
//   cumulative interim text, EndOfTurn capture) help because all of
//   them assumed audio data exists in the first place.
//
// What this DOESN'T try to be:
//   * a generic device-picker UI
//   * smart "detect silence at runtime, switch device" logic
//   * a setting the user can change without editing code
//
// Per the user's request, the rule is "always record from the MacBook
// microphone." Picking by `MediaDeviceInfo.label` regex is the only
// route that doesn't depend on a brittle deviceId we'd have to track
// across reboots — labels are stable across reboots and roughly stable
// across macOS versions. The patterns below cover every Apple-built-in
// audio input observed in the wild on macOS 14/15:
//
//     "MacBook Pro Microphone"
//     "MacBook Air Microphone"
//     "MacBook Pro 16-inch Microphone"
//     "Built-in Microphone"          (older models)
//     "iMac Microphone"
//     "Mac mini Microphone"
//
// What makes this correct:
//   * On any Mac with a built-in mic, we forcibly select it; AirPods,
//     external USB mics, headsets are all bypassed at the source.
//   * On non-Mac platforms (Linux/Windows builds, future ports) the
//     match falls through and we revert to `{ audio: true }` — current
//     behaviour, no regression.
//   * On a Mac with no built-in mic (Mac Studio, headless server)
//     enumeration finds nothing and we fall back to default. Those
//     setups always have an external mic of some kind plugged in by
//     definition, so the default is fine.
//
// What would make this wrong:
//   * If a user actually wants their USB studio mic, they can't get
//     it. Acceptable per user direction; future work is a device-
//     picker UI, not undoing this rule.
//   * If `enumerateDevices()` is ever called BEFORE permission has
//     been granted (no prior `getUserMedia`), labels come back as
//     empty strings. The match fails, we fall back to `{ audio: true }`,
//     which prompts permission. After that, subsequent calls have
//     populated labels and the rule fires. The pre-warm above already
//     primes permission before the first real dictation, so this is
//     only a concern if pre-warm itself was denied — and in that case
//     dictation is broken regardless.
async function pickAudioConstraints(
  debugSessionId: string,
): Promise<MediaStreamConstraints> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputs = devices.filter(d => d.kind === 'audioinput')
    // Full enumeration is logged so a future investigation can answer
    // "what mics were even available at this moment?" The labels are
    // user-data-ish (e.g., "Julius's AirPods Pro Microphone") but the
    // dump file is local 0o600 — same privacy posture as the existing
    // AGENT_CODE_DICTATION_DUMP webm output. See dictationJournal.ts.
    window.api.recordDictationDebugEvent(debugSessionId, {
      layer: 'DEVICE',
      event: 'enumerate:audioinput',
      data: { count: inputs.length, labels: inputs.map(d => d.label) },
    })
    const builtIn = inputs.find(d => {
      const label = (d.label ?? '').toLowerCase()
      if (!label || !label.includes('microphone')) return false
      return (
        label.includes('built-in') ||
        label.includes('built in') ||
        label.includes('macbook') ||
        /\bimac\b/.test(label) ||
        /\bmac\s*mini\b/.test(label) ||
        /\bmac\s*studio\b/.test(label)
      )
    })
    if (builtIn?.deviceId) {
      window.api.recordDictationDebugEvent(debugSessionId, {
        layer: 'DEVICE',
        event: 'select:built-in',
        data: { label: builtIn.label },
      })
      return { audio: { deviceId: { exact: builtIn.deviceId } } }
    }
    window.api.recordDictationDebugEvent(debugSessionId, {
      layer: 'DEVICE',
      event: 'select:fallback-default',
      data: { reason: 'no-built-in-match', labels: inputs.map(d => d.label) },
    })
  } catch (err) {
    // enumerateDevices() can throw inside locked-down sandboxes or
    // older WebView builds. Falling through to default is safe — same
    // behaviour as before this helper existed.
    window.api.recordDictationDebugEvent(debugSessionId, {
      layer: 'ERROR',
      event: 'enumerate:throw',
      data: { message: err instanceof Error ? err.message : String(err) },
    })
  }
  return { audio: true }
}

const VOICE_BANDS_HZ: Array<[number, number]> = [
  [120, 240],
  [240, 420],
  [420, 700],
  [700, 1100],
  [1100, 1700],
  [1700, 2600],
  [2600, 3800],
]

// Composer dictation is intentionally pane-local. The standalone
// agent-voice-dictation app uses an OS overlay because it has to paste
// into arbitrary apps; Agent Code already owns the target composer, so a
// floating knob would be the wrong abstraction here. Keeping state in this
// hook lets the transcript land as normal editable draft text and keeps
// every provider/secret decision behind the preload IPC boundary.
export type ComposerDictationController = {
  enabled: boolean
  status: DictationStatus
  label: string
  busy: boolean
  levels: number[]
  hasTranscriptPreview: boolean
  toggle: () => void
  handleShortcut: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
}

export function useComposerDictation({
  enabled,
  focused,
  provider,
  shortcut,
  input,
  setInputText,
  onMessage,
}: {
  enabled: boolean
  focused: boolean
  provider: DictationProviderId
  shortcut: string
  input: string
  setInputText: (next: string) => void
  onMessage: (message: string) => void
}): ComposerDictationController {
  const [status, setStatus] = useState<DictationStatus>('idle')
  const [levels, setLevels] = useState<number[]>(EMPTY_LEVELS)
  const [hasTranscriptPreview, setHasTranscriptPreview] = useState(false)
  const activeRef = useRef<ActiveRecording | null>(null)
  const inputRef = useRef(input)
  const statusRef = useRef<DictationStatus>('idle')
  const focusedRef = useRef(focused)
  const startRef = useRef<() => Promise<void>>(async () => {})
  const stopRef = useRef<() => Promise<void>>(async () => {})
  const pendingStopRef = useRef(false)
  const pendingDiscardRef = useRef(false)
  const hotkeyDownAtRef = useRef(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const levelRefs = useRef<number[]>([...EMPTY_LEVELS])
  const noiseFloorRef = useRef<number[]>(VOICE_BANDS_HZ.map(() => 0.08))
  // Renderer-minted debug session id for the currently-active recording.
  // Set in start() before the first emit so the file is keyed correctly;
  // cleared in a microtask in cleanup() so tail events (TRANSCRIPT
  // committed, OUTCOME logs from main) can still resolve a journal. Read
  // by the wrapped `debug(...)` helper and by callbacks that survive past
  // `activeRef = null` (audio meter tick, transcript-IPC subscription).
  const debugSessionIdRef = useRef<string | null>(null)
  // Throttle gate for AUDIO_LEVEL sample emission. 0 == "emit next tick."
  // Reset on every recording start so each session restarts the throttle
  // clock from zero. Compared against Date.now() inside the rAF tick;
  // 100 ms gap → ~10 Hz emission, dense enough to see the meter move on
  // a 250 ms-per-syllable basis without flooding the journal.
  const lastLevelEmitRef = useRef(0)

  // Prop callbacks behind refs:
  // TileLeaf passes `setInputText` and `onMessage` as fresh inline arrows on
  // every render. The previous version put `restoreBaseInput` in the dep list
  // of the unmount-only effect, which meant React re-ran that effect's CLEANUP
  // after every render — including the render that immediately followed
  // `setLifecycleStatus('recording')`. The cleanup nulled `activeRef` and
  // cancelled the WebSocket within ~1 frame of opening it, producing the exact
  // "WebSocket was closed before the connection was established" trace and
  // leaving the UI stuck on "listening" because hotkey-up then saw a null
  // active recording (and a 'recording' status, not 'starting') and refused to
  // call stop. Reading every prop callback through a ref keeps subscriptions
  // and effects pinned to stable primitives while still giving async paths the
  // latest props.
  const setInputTextRef = useRef(setInputText)
  const onMessageRef = useRef(onMessage)
  useEffect(() => {
    setInputTextRef.current = setInputText
    onMessageRef.current = onMessage
  })
  // Single chokepoint for every dictation-side write to the composer input.
  // Each caller passes a `source` tag so the terminal log can answer "who
  // wrote what, when, and what did the input look like before/after?". This
  // is how we will reproduce the rare bug where the composer shows phantom
  // text after dictation: just rewind through the trace.
  const writeInput = useCallback((next: string, source: string) => {
    inputRef.current = next
    setInputTextRef.current(next)
    // eslint-disable-next-line no-console
    console.debug('[dictation:write-input]', {
      source,
      chars: next.length,
      lifecycle: statusRef.current,
    })
  }, [])
  const reportMessage = useCallback((message: string) => {
    onMessageRef.current(message)
  }, [])

  // One-line lifecycle trace at debug level. Verbose by intent — dictation
  // bugs almost always show up as a missing transition somewhere in
  // start → record → stop → commit, and re-deriving "what happened" from a
  // single Deepgram trace is painful. console.debug is filtered out by
  // default in production builds, so this is dev-only signal.
  //
  // The same payload is also forwarded to the per-session debug journal
  // (`<userData>/dictation-debug/<id>.dictation.jsonl`). console.debug
  // disappears in production, but the journal persists across runs and
  // can be diff'd against a failing session. `layer` defaults to 'META';
  // callers tag CHUNK/RECORDER/IPC/ERROR sites explicitly so the file
  // can be filtered by layer (see preload/api/types.ts → DictationDebugLayer).
  const debug = useCallback((
    phase: string,
    details: Record<string, unknown> = {},
    layer: DictationDebugLayer = 'META',
  ) => {
    // eslint-disable-next-line no-console
    console.debug('[dictation:composer]', {
      phase,
      lifecycle: statusRef.current,
      hasRecording: !!activeRef.current,
      ...details,
    })
    const id = debugSessionIdRef.current
    if (!id) return
    window.api.recordDictationDebugEvent(id, {
      layer,
      event: phase,
      data: { lifecycle: statusRef.current, ...details },
    })
  }, [])

  useEffect(() => {
    inputRef.current = input
  }, [input])

  useEffect(() => {
    focusedRef.current = focused
  }, [focused])

  const setLifecycleStatus = useCallback((next: DictationStatus) => {
    // Hotkey down/up events are native IPC events, not React-controlled input
    // events. If we only read `status` from a render closure, key-up can race
    // the state update caused by key-down and the release gets ignored while
    // the UI sits on "listening". The standalone app keeps lifecycle in refs
    // for exactly this reason; React state is the display projection, while
    // this ref is the synchronous source of truth for recorder control.
    statusRef.current = next
    setStatus(next)
  }, [])

  const renderTranscriptPreview = useCallback((recording: ActiveRecording, text: string) => {
    // Deepgram interim text is explicitly provisional: the provider can revise
    // earlier words as more audio arrives. Treat it as a temporary composer
    // projection anchored to the input that existed when recording started,
    // not as user-owned draft text. On stop we replace this preview with the
    // final STT-wrapped text; on cancel/no-speech/error we can restore the base.
    recording.previewText = text
    const base = recording.baseInput
    const separator = base.trim().length > 0 && text.trim().length > 0 ? '\n\n' : ''
    writeInput(`${base}${separator}${text}`, 'preview')
    setHasTranscriptPreview(true)
  }, [writeInput])

  const commitTranscript = useCallback((recording: ActiveRecording, text: string) => {
    const base = recording.baseInput
    const separator = base.trim().length > 0 ? '\n\n' : ''
    writeInput(`${base}${separator}${text}`, 'commit')
    // Clear the preview flag now that the final STT-wrapped text is the
    // committed draft. Without this, hasTranscriptPreview stays true after
    // a successful commit and the next composer render observes a stale
    // "preview is in flight" signal until the next start() resets it.
    setHasTranscriptPreview(false)
    // Pair this with TRANSCRIPT:preview:interim/final to see whether the
    // live-preview path produced anything at all before the final commit
    // landed. If a session has TRANSCRIPT:committed but no preview events,
    // we're on the batch-only path (currently the default per
    // src/main/ipc/dictation.ts:84-92).
    window.api.recordDictationDebugEvent(recording.debugSessionId, {
      layer: 'TRANSCRIPT',
      event: 'committed',
      data: { textLen: text.length, head: text.slice(0, 240) },
    })
  }, [writeInput])

  const restoreBaseInput = useCallback((recording: ActiveRecording) => {
    writeInput(recording.baseInput, 'restore')
    setHasTranscriptPreview(false)
  }, [writeInput])

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    analyserRef.current = null
    levelRefs.current = [...EMPTY_LEVELS]
    noiseFloorRef.current = VOICE_BANDS_HZ.map(() => 0.08)
    setLevels(EMPTY_LEVELS)
    if (audioCtxRef.current) {
      void audioCtxRef.current.close()
      audioCtxRef.current = null
    }
    // Terminal AUDIO_LEVEL event so a reader of the journal can spot
    // "meter never produced any sample events" vs "meter ran but every
    // sample was zero." Both are dead-indicator symptoms but they
    // point at different bugs.
    const id = debugSessionIdRef.current
    if (id) {
      window.api.recordDictationDebugEvent(id, {
        layer: 'AUDIO_LEVEL',
        event: 'meter:stop',
      })
    }
  }, [])

  const startMeter = useCallback((stream: MediaStream) => {
    // This mirrors the standalone dictation pill. The right-side composer
    // affordance should reflect actual microphone energy, not a decorative
    // animation: each bar tracks a speech-frequency band with a slow noise
    // floor, then the sine curve adds only a small organic bend.
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.minDecibels = -92
    analyser.maxDecibels = -22
    analyser.smoothingTimeConstant = 0.12
    source.connect(analyser)
    audioCtxRef.current = ctx
    analyserRef.current = analyser
    void ctx.resume()

    // Configuration / track snapshot at meter-start. If a session shows
    // AUDIO_LEVEL `meter:start` with `trackMuted: [true]` or
    // `trackReadyState: ['ended']`, we know the underlying audio track
    // is dead before the analyser ever sees data — the sine wave is
    // never going to move and the bug is upstream (mic selection /
    // permission), not in the meter wiring.
    const meterStartDebugId = debugSessionIdRef.current
    if (meterStartDebugId) {
      window.api.recordDictationDebugEvent(meterStartDebugId, {
        layer: 'AUDIO_LEVEL',
        event: 'meter:start',
        data: {
          sampleRate: ctx.sampleRate,
          fftSize: analyser.fftSize,
          trackLabels: stream.getAudioTracks().map(t => t.label),
          trackMuted: stream.getAudioTracks().map(t => t.muted),
          trackReadyState: stream.getAudioTracks().map(t => t.readyState),
        },
      })
    }

    const frequencyData = new Uint8Array(analyser.frequencyBinCount)
    const bandBins = VOICE_BANDS_HZ.map(([low, high]) => ({
      start: Math.max(1, Math.floor(low / (ctx.sampleRate / analyser.fftSize))),
      end: Math.max(2, Math.ceil(high / (ctx.sampleRate / analyser.fftSize))),
    }))

    const tick = () => {
      const activeAnalyser = analyserRef.current
      if (!activeAnalyser) return
      activeAnalyser.getByteFrequencyData(frequencyData)
      const next = bandBins.map(({ start, end }, i) => {
        let sum = 0
        let count = 0
        for (let bin = start; bin <= end && bin < frequencyData.length; bin++) {
          sum += frequencyData[bin] / 255
          count += 1
        }
        const energy = count ? sum / count : 0
        const previousFloor = noiseFloorRef.current[i] ?? 0.08
        const floorRate = energy < previousFloor ? 0.08 : 0.006
        const floor = previousFloor + (energy - previousFloor) * floorRate
        noiseFloorRef.current[i] = floor
        const voiceEnergy = Math.max(0, energy - floor - 0.012)
        const signal = Math.min(1, Math.pow(voiceEnergy * 8.5, 0.72))
        const previous = levelRefs.current[i] ?? 0
        const attack = signal > previous ? 0.74 : 0.22
        return previous + (signal - previous) * attack
      })
      levelRefs.current = next
      setLevels(next)
      // Throttle to ~10 Hz. rAF fires at ~60 Hz; 10 Hz is dense enough
      // to see the meter move on a 250 ms-per-syllable basis and sparse
      // enough that a 30-second utterance lands ~300 sample events, not
      // 1800. The gate uses Date.now (millisecond resolution is fine —
      // nothing in this path needs sub-ms precision).
      const now = Date.now()
      if (now - lastLevelEmitRef.current >= 100) {
        lastLevelEmitRef.current = now
        const id = debugSessionIdRef.current
        if (id) {
          window.api.recordDictationDebugEvent(id, {
            layer: 'AUDIO_LEVEL',
            event: 'sample',
            data: {
              // 3 decimals is enough resolution to see "stuck at 0.000"
              // vs "moving"; 6 decimals would be float noise.
              levels: next.map(v => Number(v.toFixed(3))),
              // Peak per frame is what the UI uses to decide "active";
              // if peak is always tiny the indicator looks dead even
              // when individual bands have real signal.
              peak: Number(Math.max(...next).toFixed(3)),
            },
          })
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [])

  const cleanup = useCallback((recording: ActiveRecording) => {
    debug('cleanup', { id: recording.id, recorderState: recording.recorder.state })
    if (recording.streamStartTimer !== null) {
      window.clearTimeout(recording.streamStartTimer)
      recording.streamStartTimer = null
    }
    for (const track of recording.stream.getTracks()) {
      track.stop()
    }
    stopMeter()
    // Keep `debugSessionIdRef` valid through the current microtask so any
    // already-queued late callbacks (last `recorder:dataavailable` after
    // `stop()`, transcript IPC arrivals, OUTCOME from main) still write
    // into the right journal. Clearing in a microtask gives those a
    // window to flush; anything later than that has missed the boat by
    // design — every dictation press gets a fresh id on the next start().
    queueMicrotask(() => {
      if (debugSessionIdRef.current === recording.debugSessionId) {
        debugSessionIdRef.current = null
      }
    })
  }, [debug, stopMeter])

  const cancelRecording = useCallback((recording: ActiveRecording) => {
    // Match the standalone dictation app: a very short Fn press is an
    // accidental tap, not a failed transcription. Crucially, do not run it
    // through Deepgram stop/finalization; closing a CONNECTING WebSocket is the
    // exact source of the scary "closed before established" logs the user saw.
    debug('cancel-recording', {
      id: recording.id,
      recorderState: recording.recorder.state,
      queuedChunks: recording.queuedChunks.length,
      pendingPushes: recording.pendingPushes.length,
    })
    cleanup(recording)
    activeRef.current = null
    restoreBaseInput(recording)
    recording.discarded = true
    if (recording.id) {
      void window.api.cancelDictationStream({ id: recording.id })
    } else if (recording.streamStartPromise) {
      void recording.streamStartPromise.then(id => {
        if (id) void window.api.cancelDictationStream({ id })
      })
    }
    pendingStopRef.current = false
    pendingDiscardRef.current = false
    setLifecycleStatus('idle')
  }, [cleanup, debug, restoreBaseInput, setLifecycleStatus])

  const stop = useCallback(async () => {
    const recording = activeRef.current
    debug('stop:called', {
      hasRecording: !!recording,
      lifecycle: statusRef.current,
      heldMs: hotkeyDownAtRef.current ? Date.now() - hotkeyDownAtRef.current : null,
    })
    if (!recording) {
      if (statusRef.current === 'starting') {
        const heldMs = hotkeyDownAtRef.current ? Date.now() - hotkeyDownAtRef.current : null
        pendingStopRef.current = true
        pendingDiscardRef.current = heldMs !== null && heldMs < MIN_HOLD_TO_TRANSCRIBE_MS
      }
      return
    }
    if (statusRef.current === 'stopping') return

    const heldMs = hotkeyDownAtRef.current ? Date.now() - hotkeyDownAtRef.current : null
    if (heldMs !== null && heldMs < MIN_HOLD_TO_TRANSCRIBE_MS) {
      debug('stop:short-press-discard', { heldMs })
      cancelRecording(recording)
      return
    }

    setLifecycleStatus('stopping')
    debug('stop:stopping-recorder', {
      id: recording.id,
      recorderState: recording.recorder.state,
      queuedChunks: recording.queuedChunks.length,
      pendingPushes: recording.pendingPushes.length,
    }, 'RECORDER')

    const stopped = recording.recorder.state === 'inactive'
      ? Promise.resolve()
      : new Promise<void>(resolve => {
          recording.recorder.addEventListener('stop', () => resolve(), { once: true })
        })

    if (recording.recorder.state !== 'inactive') {
      try {
        recording.recorder.requestData()
        debug('stop:request-data', { id: recording.id }, 'RECORDER')
      } catch (err) {
        debug('stop:request-data-error', {
          id: recording.id,
          message: err instanceof Error ? err.message : String(err),
        }, 'ERROR')
      }
      recording.recorder.stop()
      debug('stop:recorder-stop-called', { id: recording.id }, 'RECORDER')
    }

    try {
      await stopped
      debug('stop:recorder-stopped', {
        id: recording.id,
        queuedChunks: recording.queuedChunks.length,
        pendingPushes: recording.pendingPushes.length,
      }, 'RECORDER')
      await Promise.allSettled(recording.pendingPushes)
      debug('stop:pending-pushes-settled', {
        id: recording.id,
        queuedChunks: recording.queuedChunks.length,
        pendingPushes: recording.pendingPushes.length,
        hasStreamStartPromise: !!recording.streamStartPromise,
      }, 'IPC')
      const streamId = recording.id ?? await recording.streamStartPromise
      if (!streamId) {
        cleanup(recording)
        activeRef.current = null
        restoreBaseInput(recording)
        reportMessage('No speech detected')
        setLifecycleStatus('idle')
        return
      }

      const result = await window.api.stopDictationStream({
        id: streamId,
        audioDurationMs: Date.now() - recording.startedAt,
      })
      debug('stop:ipc-result', {
        id: streamId,
        kind: result.kind,
        audioDurationMs: Date.now() - recording.startedAt,
      }, 'IPC')

      cleanup(recording)
      activeRef.current = null

      if (result.kind === 'success') {
        commitTranscript(recording, result.text)
        setLifecycleStatus('idle')
        return
      }

      if (result.kind === 'no-speech') {
        restoreBaseInput(recording)
        reportMessage('No speech detected')
        setLifecycleStatus('idle')
        return
      }

      restoreBaseInput(recording)
      reportMessage(result.message)
      setLifecycleStatus('error')
      window.setTimeout(() => setLifecycleStatus('idle'), 1600)
    } catch (err) {
      cleanup(recording)
      activeRef.current = null
      restoreBaseInput(recording)
      reportMessage(err instanceof Error ? err.message : 'Dictation failed')
      setLifecycleStatus('error')
      window.setTimeout(() => setLifecycleStatus('idle'), 1600)
    }
  }, [cancelRecording, cleanup, commitTranscript, debug, reportMessage, restoreBaseInput, setLifecycleStatus])

  useEffect(() => {
    if (enabled) return
    const recording = activeRef.current
    if (!recording) return
    activeRef.current = null
    cleanup(recording)
    restoreBaseInput(recording)
    recording.discarded = true
    if (recording.id) {
      void window.api.cancelDictationStream({ id: recording.id })
    } else if (recording.streamStartPromise) {
      void recording.streamStartPromise.then(id => {
        if (id) void window.api.cancelDictationStream({ id })
      })
    }
    setLifecycleStatus('idle')
  }, [cleanup, enabled, restoreBaseInput, setLifecycleStatus])

  useEffect(() => () => {
    // True unmount cleanup: empty deps so this fires once when the component
    // really goes away. Earlier this effect listed `[cleanup, restoreBaseInput]`
    // as deps, and because `restoreBaseInput` reset its identity on every
    // render (it closed over the unstable `setInputText` prop), React called
    // this cleanup on EVERY render — killing the active recording within a
    // frame of starting it. Inline the few lines we need, pull state through
    // refs, and never put a prop-derived callback in here.
    const recording = activeRef.current
    if (!recording) return
    activeRef.current = null
    if (recording.streamStartTimer !== null) {
      window.clearTimeout(recording.streamStartTimer)
      recording.streamStartTimer = null
    }
    for (const track of recording.stream.getTracks()) track.stop()
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close()
      audioCtxRef.current = null
    }
    recording.discarded = true
    if (recording.id) {
      void window.api.cancelDictationStream({ id: recording.id })
    } else if (recording.streamStartPromise) {
      void recording.streamStartPromise.then(id => {
        if (id) void window.api.cancelDictationStream({ id })
      })
    }
    // No setInputText here on purpose: by the time we reach unmount, the
    // composer that owned the draft is gone — touching it would just race the
    // teardown of the parent component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = useCallback(async () => {
    if (!enabled || activeRef.current || statusRef.current !== 'idle') return
    // Mint and publish the debug-session id BEFORE any debug(...) calls
    // so the first emit (`start:begin`) already has a route to the
    // journal. The id outlives `activeRef`: callbacks that fire after
    // cleanup (transcript IPC, tail OUTCOME from main) still resolve a
    // file via the ref. Cleared on cleanup() in a microtask — see the
    // debugSessionIdRef declaration for the WHY.
    const debugSessionId = crypto.randomUUID()
    debugSessionIdRef.current = debugSessionId
    lastLevelEmitRef.current = 0
    window.api.recordDictationDebugEvent(debugSessionId, {
      layer: 'META',
      event: 'session:created',
      data: {
        provider,
        focused: focusedRef.current,
        baseInputLen: inputRef.current.length,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
      },
    })
    debug('start:begin', { provider, focused: focusedRef.current })
    setHasTranscriptPreview(false)
    setLifecycleStatus('starting')

    try {
      const gumStartedAt = Date.now()
      // Force the built-in Mac microphone when one is enumerable.
      // See pickAudioConstraints above for the full rationale —
      // short version: AirPods (and other Bluetooth headsets) become
      // the OS default input on pairing, and Chromium opens them in
      // HFP/SCO mode where the stream produces zero audio samples,
      // killing the level meter and producing empty transcripts.
      const constraints = await pickAudioConstraints(debugSessionId)
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      debug('start:get-user-media:done', {
        ms: Date.now() - gumStartedAt,
        // `forcedDeviceId` reflects what we asked for, NOT what we
        // got. The granted track's `label` is the source of truth —
        // useful for verifying that the built-in selection actually
        // landed at runtime.
        forcedDeviceId:
          typeof constraints.audio === 'object' && constraints.audio !== null
            ? (constraints.audio.deviceId as { exact?: string } | undefined)?.exact ?? null
            : null,
        tracks: stream.getAudioTracks().map(track => ({
          label: track.label,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState,
        })),
      }, 'DEVICE')
      if (pendingStopRef.current && pendingDiscardRef.current) {
        for (const track of stream.getTracks()) track.stop()
        pendingStopRef.current = false
        pendingDiscardRef.current = false
        setLifecycleStatus('idle')
        return
      }
      const requestedMimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, requestedMimeType ? { mimeType: requestedMimeType } : undefined)
      const recorderMimeType = recorder.mimeType || requestedMimeType || null
      debug('start:recorder-created', {
        requestedMimeType,
        recorderMimeType,
        state: recorder.state,
      }, 'RECORDER')
      const recording: ActiveRecording = {
        id: null,
        debugSessionId,
        recorder,
        stream,
        mimeType: recorderMimeType,
        startedAt: Date.now(),
        baseInput: inputRef.current,
        previewText: '',
        queuedChunks: [],
        pendingPushes: [],
        chunkChain: Promise.resolve(),
        nextChunkIndex: 0,
        streamStartPromise: null,
        streamStartTimer: null,
        discarded: false,
      }
      activeRef.current = recording

      const ensureStreamStarted = () => {
        if (recording.streamStartPromise) return recording.streamStartPromise
        debug('stream:start:request', {
          mimeType: recording.mimeType,
          queuedChunks: recording.queuedChunks.length,
          recorderState: recording.recorder.state,
        }, 'IPC')
        // Keep the provider socket lifecycle behind the recorder lifecycle.
        // The first Agent Code port opened Deepgram before the MediaRecorder was
        // definitely running, so a release during startup closed a CONNECTING
        // WebSocket and left the composer stuck on "listening". The standalone
        // app avoids that by letting the recorder own the lifecycle and by
        // queueing audio until the provider session is ready; this mirrors that
        // shape in the composer hook.
        recording.streamStartPromise = window.api.startDictationStream({
          provider,
          debugSessionId: recording.debugSessionId,
          ...(recording.mimeType ? { mimeType: recording.mimeType } : {}),
        }).then(async started => {
          debug('stream:start:result', {
            kind: started.kind,
            id: started.kind === 'started' ? started.id : null,
            message: started.kind === 'error' ? started.message : null,
          }, 'IPC')
          if (started.kind !== 'started') {
            throw new Error(started.message)
          }
          if (recording.discarded || activeRef.current !== recording) {
            await window.api.cancelDictationStream({ id: started.id })
            return null
          }
          // Drain queued chunks BEFORE publishing recording.id, then publish
          // atomically. Two bugs were producing intermittent "unsupported data
          // format" errors from Deepgram on cold start:
          //
          //   1. The previous version set `recording.id = started.id` BEFORE
          //      draining. Any dataavailable handler that resolved during the
          //      drain saw the id and IPC'd its chunk DIRECTLY, interleaving
          //      with the queued flush. Result: Deepgram receives a non-init
          //      WebM cluster before the EBML/init segment and rejects the
          //      stream. On warm runs the queue had already drained by the
          //      time later chunks arrived, so it worked; on cold runs the
          //      WS handshake took long enough to widen the race.
          //   2. The previous flush used `splice(0)`, snapshotting the queue
          //      once. Any chunk pushed during the for-loop's awaits landed
          //      in the (now-empty) queue and was never sent.
          //
          // The while loop fixes both: it keeps the id null while draining
          // (so concurrent handlers continue to enqueue), and it picks up any
          // chunks that arrive mid-drain. After the loop exits the queue is
          // empty AND we publish the id in the same synchronous tick, so the
          // next dataavailable sees the id and goes direct.
          let drained = 0
          while (recording.queuedChunks.length > 0) {
            const queued = recording.queuedChunks.shift()!
            const result = await window.api.pushDictationChunk({ id: started.id, chunk: queued.chunk })
            if (result.kind === 'error') throw new Error(result.message)
            drained += 1
          }
          recording.id = started.id
          debug('stream:drain-and-publish', { id: started.id, drained }, 'IPC')
          return started.id
        }).catch(err => {
          debug('stream:start:error', {
            message: err instanceof Error ? err.message : String(err),
            discarded: recording.discarded,
          }, 'ERROR')
          if (!recording.discarded) throw err
          return null
        })
        void recording.streamStartPromise.catch(() => {})
        return recording.streamStartPromise
      }

      recorder.addEventListener('dataavailable', event => {
        const chunkIndex = recording.nextChunkIndex
        recording.nextChunkIndex += 1
        debug('recorder:dataavailable', {
          chunkIndex,
          size: event.data.size,
          type: event.data.type,
          recorderState: recorder.state,
          elapsedMs: Date.now() - recording.startedAt,
          streamId: recording.id,
          queuedChunks: recording.queuedChunks.length,
        }, 'RECORDER')
        if (event.data.size <= 1) return
        // MediaRecorder fires `dataavailable` in order, but the Blob ->
        // ArrayBuffer conversion is asynchronous and does not preserve that
        // ordering for us. That was the root cause of Deepgram's intermittent
        // `UNPARSABLE_CLIENT_MESSAGE` failures: when chunk 1's conversion won
        // the race against chunk 0, the queued WebM stream began with a media
        // cluster instead of the EBML/init segment. Deepgram quite reasonably
        // rejected "sequence_id: 1" as corrupt even though the microphone,
        // permissions, and websocket were all fine.
        //
        // Chain the whole conversion + local queue/provider push in event order.
        // This costs at most one chunk of latency, which is invisible next to the
        // ~500ms provider handshake, and it preserves the only invariant WebM
        // streaming absolutely requires: byte order must match recorder order.
        const previousChunk = recording.chunkChain
        const push = previousChunk
          .then(async () => {
            const chunk = await event.data.arrayBuffer()
            if (recording.discarded) return { kind: 'ignored' as const }
            // SINGLE MOST IMPORTANT EVENT in the whole dump: pair this
            // sha8 against the main side's CHUNK:main:received for the
            // same chunkIndex. Mismatched sha → IPC corruption. Missing
            // main:received → IPC drop. Renderer-produced before stream
            // open → expect a queued-local path next, not push-ipc.
            const fingerprint = await sha8(chunk)
            window.api.recordDictationDebugEvent(recording.debugSessionId, {
              layer: 'CHUNK',
              event: 'renderer:produced',
              data: {
                chunkIndex,
                bytes: chunk.byteLength,
                sha8: fingerprint,
                streamId: recording.id,
                queueLenAtEmit: recording.queuedChunks.length,
              },
            })
            const id = recording.id
            if (!id) {
              recording.queuedChunks.push({ index: chunkIndex, chunk })
              const heldMs = Date.now() - recording.startedAt
              debug('recorder:chunk:queued-local', {
                chunkIndex,
                bytes: chunk.byteLength,
                heldMs,
                queuedChunks: recording.queuedChunks.length,
              }, 'CHUNK')
              if (heldMs >= MIN_HOLD_TO_TRANSCRIBE_MS) {
                void ensureStreamStarted()
              } else if (recording.streamStartTimer === null) {
                // Do not open Deepgram for the accidental-tap window. The
                // standalone app discards <180ms presses; in Agent Code the
                // provider socket was being created early enough that those
                // discarded taps still produced "WebSocket was closed before
                // the connection was established". Queue locally until the
                // press is old enough to be a real dictation attempt.
                recording.streamStartTimer = window.setTimeout(() => {
                  recording.streamStartTimer = null
                  if (activeRef.current === recording && !recording.discarded && recording.queuedChunks.length > 0) {
                    void ensureStreamStarted()
                  }
                }, MIN_HOLD_TO_TRANSCRIBE_MS - heldMs)
              }
              return { kind: 'ok' as const }
            }
            debug('recorder:chunk:push-ipc', {
              id,
              chunkIndex,
              bytes: chunk.byteLength,
              elapsedMs: Date.now() - recording.startedAt,
            }, 'CHUNK')
            const result = await window.api.pushDictationChunk({ id, chunk })
            if (result.kind === 'error') throw new Error(result.message)
            return result
          })
          .catch(err => {
            debug('recorder:chunk:push-error', {
              message: err instanceof Error ? err.message : String(err),
            }, 'ERROR')
            throw err
          })
        recording.chunkChain = push.then(() => undefined, () => undefined)
        recording.pendingPushes.push(push)
      })

      recorder.addEventListener('error', event => {
        debug('recorder:error', {
          message: event.error?.message ?? null,
          name: event.error?.name ?? null,
        }, 'ERROR')
        reportMessage(event.error?.message ?? 'Dictation recorder failed')
        recording.discarded = true
        if (recording.id) void window.api.cancelDictationStream({ id: recording.id })
        cleanup(recording)
        activeRef.current = null
        setLifecycleStatus('error')
        window.setTimeout(() => setLifecycleStatus('idle'), 1600)
      })

      // 120ms matches the standalone dictation app's current WebM/Opus
      // cadence closely enough that Deepgram sees a steady stream, while
      // still keeping IPC overhead tiny compared with audio/network cost.
      recorder.start(120)
      debug('recorder:start-called', {
        state: recorder.state,
        timesliceMs: 120,
      }, 'RECORDER')
      startMeter(stream)
      setLifecycleStatus('recording')
      if (pendingStopRef.current) {
        if (pendingDiscardRef.current) {
          cancelRecording(recording)
          return
        }
        pendingStopRef.current = false
        window.setTimeout(() => void stopRef.current(), 0)
      }
    } catch (err) {
      debug('start:error', {
        message: err instanceof Error ? err.message : String(err),
      }, 'ERROR')
      reportMessage(err instanceof Error ? err.message : 'Could not start dictation')
      setLifecycleStatus('error')
      window.setTimeout(() => setLifecycleStatus('idle'), 1600)
    }
  }, [cancelRecording, cleanup, debug, enabled, provider, reportMessage, setLifecycleStatus, startMeter])

  useEffect(() => {
    startRef.current = start
    stopRef.current = stop
  }, [start, stop])

  const renderTranscriptPreviewRef = useRef(renderTranscriptPreview)
  useEffect(() => {
    renderTranscriptPreviewRef.current = renderTranscriptPreview
  })
  useEffect(() => {
    // Keep this subscription pinned to `enabled` only. If we depended on
    // `renderTranscriptPreview` here we would tear down and re-register the
    // IPC listener on every render, which means a transcript event arriving
    // mid-render could miss the listener entirely.
    if (!enabled) return
    return window.api.onDictationStreamTranscript(event => {
      const recording = activeRef.current
      if (!recording || recording.id !== event.id) return
      if (!event.text.trim()) return
      // If the journal shows TRANSCRIPT:preview:interim events flowing
      // but the sine wave is dead, the bug is in audio-levels (AnalyserNode
      // wiring) not in the provider. If there are NO preview events at
      // all, the bug is in the provider path (most likely: we're on the
      // batch-only fallback in src/main/ipc/dictation.ts and the renderer
      // is right to expect nothing).
      window.api.recordDictationDebugEvent(recording.debugSessionId, {
        layer: 'TRANSCRIPT',
        event: event.isFinal ? 'preview:final' : 'preview:interim',
        data: {
          streamId: event.id,
          source: event.source,
          textLen: event.text.length,
          head: event.text.slice(0, 240),
        },
      })
      renderTranscriptPreviewRef.current(recording, event.text)
    })
  }, [enabled])

  const toggle = useCallback(() => {
    if (!enabled) return
    if (activeRef.current) {
      void stop()
    } else {
      void start()
    }
  }, [enabled, start, stop])

  // Hotkey wiring goes through a shared registry instead of one IPC
  // subscription per TileLeaf. Two reasons:
  //   1. Multiple TileLeaf hooks were each subscribing AND each gating on
  //      their own focus. On a fresh launch nothing is focused, so the press
  //      was a silent no-op everywhere — that was the "doesn't work for 30s
  //      after launch" report. The registry picks the focused composer if
  //      there is one, and otherwise the most-recently-focused composer, so
  //      Fn always lands somewhere as soon as the helper says "ready".
  //   2. One IPC subscription instead of N also fixes the case where the
  //      registry picks a different target between press and release. The
  //      registry remembers which target consumed the press and routes the
  //      release to that same target, so a quick Fn tap can never leave a
  //      recorder orphaned because focus moved mid-hold.
  const lastFocusedAtRef = useRef(0)
  useEffect(() => {
    if (focused) lastFocusedAtRef.current = Date.now()
  }, [focused])
  useEffect(() => {
    if (!enabled) return
    // Kick off a one-time mic warm-up the moment dictation becomes enabled
    // for any composer. See the comment on prewarmMicrophone — this turns the
    // first Fn press from "stuck for 4+ seconds" into "instant".
    void prewarmMicrophone()
    const handle: DictationTargetHandle = {
      get enabled() { return enabled },
      get focused() { return focusedRef.current },
      get lastFocusedAt() { return lastFocusedAtRef.current },
      start: () => {
        hotkeyDownAtRef.current = Date.now()
        pendingDiscardRef.current = false
        if (statusRef.current === 'idle') void startRef.current()
      },
      stop: () => {
        if (activeRef.current || statusRef.current === 'starting') void stopRef.current()
      },
      isStarting: () => statusRef.current === 'starting',
      isActive: () => activeRef.current !== null,
    }
    return registerDictationTarget(handle)
  }, [enabled])

  const handleShortcut = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!enabled || !shortcut.trim()) return false
    // Renderer keydown stays as a focused fallback for browser-visible chords.
    // Bare Fn is handled above by the native main-process helper because the
    // browser event model is not a reliable source for that physical key.
    if (!keyboardEventMatchesBinding(event, shortcut)) return false
    event.preventDefault()
    event.stopPropagation()
    toggle()
    return true
  }, [enabled, shortcut, toggle])

  return {
    enabled,
    status,
    busy: status === 'starting' || status === 'recording' || status === 'stopping',
    levels,
    hasTranscriptPreview,
    label:
      status === 'recording'
        ? 'Stop dictation'
        : status === 'starting'
          ? 'Starting dictation'
          : status === 'stopping'
            ? 'Transcribing'
            : 'Start dictation',
    toggle,
    handleShortcut,
  }
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus'
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm'
  return undefined
}
