import { useCallback, useRef, useState } from 'react'

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

export function useMobileDictation(params: {
  token: string
  onTranscript: (text: string) => void
  onError: (message: string | null) => void
}): ComposerDictationController {
  const [status, setStatus] = useState<DictationStatus>('idle')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const mimeRef = useRef<string>('')

  // busy drives the shell's activity meter (enabled && busy). Every non-rest
  // phase counts so the meter is visible from the moment the mic is tapped.
  const busy = status === 'starting' || status === 'recording' || status === 'stopping'

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
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
    recorderRef.current = null

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
      } else {
        params.onError('Transcription failed — try again.')
      }
    } catch {
      params.onError('Dictation upload failed — check the connection.')
    } finally {
      setStatus('idle')
    }
  }, [params])

  const start = useCallback(async () => {
    setStatus('starting')
    params.onError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      mimeRef.current = recorder.mimeType || mimeType
      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunksRef.current.push(e.data)
      }
      streamRef.current = stream
      recorderRef.current = recorder
      recorder.start()
      setStatus('recording')
    } catch {
      streamRef.current = null
      recorderRef.current = null
      setStatus('idle')
      params.onError('Microphone access denied.')
    }
  }, [params])

  const toggle = useCallback(() => {
    if (status === 'recording') void stopAndTranscribe()
    else if (status === 'idle' || status === 'error') void start()
    // 'starting' / 'stopping' are transient — ignore taps mid-transition so a
    // double-tap can't spawn a second recorder or a race between start/stop.
  }, [status, start, stopAndTranscribe])

  return {
    enabled: true,
    status,
    label:
      status === 'recording'
        ? 'Recording…'
        : status === 'stopping'
          ? 'Transcribing…'
          : status === 'starting'
            ? 'Starting…'
            : 'Dictate',
    busy,
    levels: [], // No live level meter on the phone (v1); the shell shows dots.
    hasTranscriptPreview: false,
    toggle,
    // The desktop uses this for the Fn-key path; the phone drives dictation
    // from the tap mic button instead, so no keyboard shortcut is handled.
    handleShortcut: () => false,
  }
}
