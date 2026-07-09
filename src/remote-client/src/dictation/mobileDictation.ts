import { useCallback, useEffect, useRef, useState } from 'react'

import type { ComposerDictationController } from '@renderer/workspace/tile-tree/TileLeaf/useComposerDictation'
import type { DictationStatus } from '@shared/types/dictation'

// Phone-side voice dictation.
//
// WHY capture is rolled inline here instead of importing the
// agent-voice-dictation package's browserRecorder: that package's main entry
// (`agent-voice-dictation`) re-exports its Deepgram STREAMING client, which
// pulls Node-only modules (`ws`, `node:crypto`). Bundling that into a browser
// build breaks, and the package exposes no browser-only `./recorder` subpath
// export to import around it. So we use a self-contained MediaRecorder — the
// same primitives the desktop's useComposerDictation uses directly — and keep
// the phone bundle free of the node-only package.
//
// WHY transcription is NOT done here: the blob is POSTed to the desktop's
// token-gated /dictate route, which runs the real Deepgram batch engine
// server-side. The API key stays on the desktop and never reaches the phone —
// that split is the whole reason /dictate exists rather than the phone calling
// Deepgram itself. The returned text is already <stt>-wrapped by the server so
// it reads to the agent exactly like a desktop-dictated prompt.
//
// SECURE-CONTEXT CONSTRAINT (why the mic can be disabled at mount): the
// default LAN pairing flow serves the client over plain `http://<lan-ip>`,
// and mobile browsers only expose `navigator.mediaDevices` in a secure
// context (https, or localhost). On a plain-http origin getUserMedia doesn't
// "fail with a permission error" — the API is simply ABSENT, and treating
// that as "Microphone access denied" sent a real debugging session chasing a
// phantom permission prompt (review finding). Serving LAN https is a separate
// project (cert provisioning + trust on the phone), so v1's contract is:
// detect the missing prerequisite BEFORE any capture attempt, disable the mic
// with the real reason, and never misattribute it to permissions. Tunnel
// transports (https by construction) are unaffected.
//
// This satisfies the full ComposerDictationController the real desktop
// ComposerInput shell requires, so mounting it lights up the shell's activity
// meter while recording. The desktop starts dictation from the Fn hotkey; a
// phone has no Fn key, so an explicit tap mic button (in SessionView) calls
// toggle().

function pickMimeType(): string {
  // Prefer webm/opus (what Deepgram batch handles best); mp4 is the iOS
  // Safari fallback since Safari historically lacked webm MediaRecorder.
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

type CaptureSupport = { ok: true } | { ok: false; reason: string }

function detectCaptureSupport(): CaptureSupport {
  // Order matters: on an insecure origin `navigator.mediaDevices` is
  // undefined ENTIRELY, so a bare capability check would report "capture not
  // supported" on browsers that support it perfectly well over https. Check
  // the secure-context bit first so the message names the actual fix (open
  // via a secure origin), not a misleading browser-support complaint.
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      ok: false,
      reason: 'Dictation needs HTTPS — open this page via a secure origin.',
    }
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: 'Microphone capture is not supported in this browser.' }
  }
  if (typeof MediaRecorder === 'undefined') {
    return { ok: false, reason: 'Audio recording is not supported in this browser.' }
  }
  return { ok: true }
}

// Evaluated once at module load: secure-context-ness and API presence are
// fixed for the lifetime of the page, so there is nothing to re-detect per
// render or per session.
const CAPTURE_SUPPORT: CaptureSupport = detectCaptureSupport()

export function useMobileDictation(params: {
  token: string
  /** Server-declared STT availability from the WS hello frame: false = the
   *  desktop has no Deepgram key wired, so /dictate can only 503 — disable
   *  the mic up front instead of failing after the user records and uploads.
   *  null = unknown (hello not received yet, or a pre-capability backend);
   *  treated as available so version skew degrades to the old
   *  fail-at-upload behavior rather than hiding a working mic. */
  sttAvailable: boolean | null
  onTranscript: (text: string) => void
  onError: (message: string | null) => void
}): ComposerDictationController {
  const [status, setStatus] = useState<DictationStatus>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mimeRef = useRef<string>('')
  // Set by the unmount cleanup so an in-flight getUserMedia that resolves
  // AFTER unmount releases its tracks instead of parking a hot mic in a ref
  // nobody will ever read again (review finding — the browser's recording
  // indicator stayed lit after navigating away mid-start).
  const unmountedRef = useRef(false)

  // busy drives the shell's activity meter (enabled && busy). Every non-rest
  // phase counts so the meter is visible from the moment the mic is tapped.
  const busy = status === 'starting' || status === 'recording' || status === 'stopping'

  // The one place capture resources die. Track.stop() is what actually
  // releases the mic (and the browser's recording indicator); dropping the
  // refs without it leaks a live capture — which is why every exit path
  // (stop, error, unmount) funnels through here (review finding: the start()
  // failure path and unmount didn't stop tracks at all).
  const releaseCapture = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
    recorderRef.current = null
  }, [])

  useEffect(
    () => () => {
      unmountedRef.current = true
      // Unmount while recording (user taps Back mid-dictation): stop the
      // recorder first so it detaches from the stream, then kill the tracks.
      // The recorder's onstop continuation belongs to a dead component —
      // nothing awaits it, and the blob it would assemble is discarded.
      try {
        if (recorderRef.current && recorderRef.current.state !== 'inactive') {
          recorderRef.current.stop()
        }
      } catch {
        // Already-stopped recorders throw InvalidStateError; the tracks
        // below still get released either way.
      }
      releaseCapture()
    },
    [releaseCapture],
  )

  const stopAndTranscribe = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder) {
      setStatus('idle')
      return
    }
    setStatus('stopping')
    // Wait for the recorder to flush its final chunk before assembling the blob.
    const blob = await new Promise<Blob>(resolve => {
      recorder.onstop = () =>
        resolve(new Blob(chunksRef.current, { type: mimeRef.current || 'audio/webm' }))
      recorder.stop()
    })
    releaseCapture()

    try {
      const res = await fetch('/dictate', {
        method: 'POST',
        headers: {
          // Same Authorization: Bearer scheme the /dictate handler verifies.
          Authorization: `Bearer ${params.token}`,
          'content-type': mimeRef.current || 'audio/webm',
        },
        body: blob,
      })
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; text?: string }
        if (data.ok && data.text) params.onTranscript(data.text)
        params.onError(null)
      } else if (res.status === 401) {
        params.onError('Dictation unauthorized — re-pair this device.')
      } else if (res.status === 503) {
        params.onError('Dictation unavailable on the desktop (no STT key configured).')
      } else if (res.status === 413) {
        params.onError('Recording too long to transcribe — try a shorter one.')
      } else {
        params.onError('Transcription failed — try again.')
      }
    } catch {
      params.onError('Dictation upload failed — check the connection.')
    } finally {
      setStatus('idle')
    }
  }, [params, releaseCapture])

  const start = useCallback(async () => {
    setStatus('starting')
    params.onError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (unmountedRef.current) {
        // The component died while the permission prompt was up — release
        // immediately; there is no UI left to record for.
        for (const track of stream.getTracks()) track.stop()
        return
      }
      // Park the stream in the ref BEFORE constructing the recorder: the
      // MediaRecorder constructor can throw (e.g. an unsupported mimeType on
      // an exotic browser), and when the stream only lived in a local the
      // catch below couldn't stop its tracks — a hot mic surviving the error
      // (review finding).
      streamRef.current = stream
      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      mimeRef.current = recorder.mimeType || mimeType
      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      recorderRef.current = recorder
      recorder.start()
      setStatus('recording')
    } catch {
      releaseCapture()
      setStatus('idle')
      // Accurate now that capture prerequisites are pre-checked (see
      // CAPTURE_SUPPORT): reaching this catch means mediaDevices existed and
      // the user (or OS) actually refused the microphone.
      params.onError('Microphone access denied.')
    }
  }, [params, releaseCapture])

  // Why the mic is disabled, or null when it can work. Precedence: a missing
  // capture prerequisite (secure context / browser API) beats the server-side
  // key gap — fixing the key wouldn't make an http origin record.
  const disabledReason = !CAPTURE_SUPPORT.ok
    ? CAPTURE_SUPPORT.reason
    : params.sttAvailable === false
      ? 'Dictation unavailable — no STT key configured on the desktop.'
      : null

  const toggle = useCallback(() => {
    if (disabledReason) {
      // The button is rendered disabled so this is normally unreachable, but
      // the shell's shortcut path (or a future caller) must still get the
      // REAL reason, not a capture attempt that dies with a fake
      // permission error.
      params.onError(disabledReason)
      return
    }
    if (status === 'recording') void stopAndTranscribe()
    else if (status === 'idle' || status === 'error') void start()
    // 'starting' / 'stopping' are transient — ignore taps mid-transition so a
    // double-tap can't spawn a second recorder or a race between start/stop.
  }, [disabledReason, params, status, start, stopAndTranscribe])

  return {
    enabled: disabledReason === null,
    status,
    // When disabled, the label carries the full reason — SessionView surfaces
    // it as the mic button's tooltip/title, which is the "explain, don't
    // fake-fail" contract for the insecure-LAN and no-STT-key states.
    label:
      disabledReason ??
      (status === 'recording'
        ? 'Recording…'
        : status === 'stopping'
          ? 'Transcribing…'
          : status === 'starting'
            ? 'Starting…'
            : 'Dictate'),
    busy,
    levels: [], // No live level meter on the phone (v1); the shell shows dots.
    hasTranscriptPreview: false,
    toggle,
    // The desktop uses this for the Fn-key path; the phone drives dictation
    // from the tap mic button instead, so no keyboard shortcut is handled.
    handleShortcut: () => false,
  }
}
