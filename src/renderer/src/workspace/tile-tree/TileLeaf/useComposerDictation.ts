import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'

import type { DictationProviderId } from '@renderer/app-state/settings/types'
import { keyboardEventMatchesBinding } from '@renderer/lib/hotkeyBinding'

type DictationStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'error'

type ActiveRecording = {
  id: string
  recorder: MediaRecorder
  stream: MediaStream
  startedAt: number
  pendingPushes: Promise<unknown>[]
}

// Composer dictation is intentionally pane-local. The standalone
// agent-voice-dictation app uses an OS overlay because it has to paste
// into arbitrary apps; cc-shell already owns the target composer, so a
// floating knob would be the wrong abstraction here. Keeping state in this
// hook lets the transcript land as normal editable draft text and keeps
// every provider/secret decision behind the preload IPC boundary.
export type ComposerDictationController = {
  enabled: boolean
  status: DictationStatus
  label: string
  busy: boolean
  toggle: () => void
  handleShortcut: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
}

export function useComposerDictation({
  enabled,
  provider,
  shortcut,
  input,
  setInputText,
  onMessage,
}: {
  enabled: boolean
  provider: DictationProviderId
  shortcut: string
  input: string
  setInputText: (next: string) => void
  onMessage: (message: string) => void
}): ComposerDictationController {
  const [status, setStatus] = useState<DictationStatus>('idle')
  const activeRef = useRef<ActiveRecording | null>(null)
  const inputRef = useRef(input)

  useEffect(() => {
    inputRef.current = input
  }, [input])

  const appendTranscript = useCallback((text: string) => {
    const current = inputRef.current
    const separator = current.trim().length > 0 ? '\n\n' : ''
    const next = `${current}${separator}${text}`
    inputRef.current = next
    setInputText(next)
  }, [setInputText])

  const cleanup = useCallback((recording: ActiveRecording) => {
    for (const track of recording.stream.getTracks()) {
      track.stop()
    }
  }, [])

  const stop = useCallback(async () => {
    const recording = activeRef.current
    if (!recording || status === 'stopping') return
    setStatus('stopping')

    const stopped = recording.recorder.state === 'inactive'
      ? Promise.resolve()
      : new Promise<void>(resolve => {
          recording.recorder.addEventListener('stop', () => resolve(), { once: true })
        })

    if (recording.recorder.state !== 'inactive') {
      recording.recorder.requestData()
      recording.recorder.stop()
    }

    try {
      await stopped
      await Promise.allSettled(recording.pendingPushes)

      const result = await window.api.stopDictationStream({
        id: recording.id,
        audioDurationMs: Date.now() - recording.startedAt,
      })

      cleanup(recording)
      activeRef.current = null

      if (result.kind === 'success') {
        appendTranscript(result.text)
        setStatus('idle')
        return
      }

      if (result.kind === 'no-speech') {
        onMessage('No speech detected')
        setStatus('idle')
        return
      }

      onMessage(result.message)
      setStatus('error')
      window.setTimeout(() => setStatus('idle'), 1600)
    } catch (err) {
      cleanup(recording)
      activeRef.current = null
      onMessage(err instanceof Error ? err.message : 'Dictation failed')
      setStatus('error')
      window.setTimeout(() => setStatus('idle'), 1600)
    }
  }, [appendTranscript, cleanup, onMessage, status])

  useEffect(() => {
    if (enabled) return
    const recording = activeRef.current
    if (!recording) return
    activeRef.current = null
    cleanup(recording)
    void window.api.cancelDictationStream({ id: recording.id })
    setStatus('idle')
  }, [cleanup, enabled])

  useEffect(() => () => {
    const recording = activeRef.current
    if (!recording) return
    activeRef.current = null
    cleanup(recording)
    void window.api.cancelDictationStream({ id: recording.id })
  }, [cleanup])

  const start = useCallback(async () => {
    if (!enabled || activeRef.current || status !== 'idle') return
    setStatus('starting')

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = pickMimeType()
      const started = await window.api.startDictationStream({
        provider,
        ...(mimeType ? { mimeType } : {}),
      })

      if (started.kind !== 'started') {
        for (const track of stream.getTracks()) track.stop()
        onMessage(started.message)
        setStatus('error')
        window.setTimeout(() => setStatus('idle'), 1600)
        return
      }

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const recording: ActiveRecording = {
        id: started.id,
        recorder,
        stream,
        startedAt: Date.now(),
        pendingPushes: [],
      }
      activeRef.current = recording

      recorder.addEventListener('dataavailable', event => {
        if (event.data.size <= 1) return
        const push = event.data.arrayBuffer()
          .then(chunk => window.api.pushDictationChunk({ id: started.id, chunk }))
        recording.pendingPushes.push(push)
      })

      recorder.addEventListener('error', () => {
        onMessage('Dictation recorder failed')
        void window.api.cancelDictationStream({ id: started.id })
        cleanup(recording)
        activeRef.current = null
        setStatus('error')
        window.setTimeout(() => setStatus('idle'), 1600)
      })

      // 120ms matches the standalone dictation app's current WebM/Opus
      // cadence closely enough that Deepgram sees a steady stream, while
      // still keeping IPC overhead tiny compared with audio/network cost.
      recorder.start(120)
      setStatus('recording')
    } catch (err) {
      onMessage(err instanceof Error ? err.message : 'Could not start dictation')
      setStatus('error')
      window.setTimeout(() => setStatus('idle'), 1600)
    }
  }, [cleanup, enabled, onMessage, provider, status])

  const toggle = useCallback(() => {
    if (!enabled) return
    if (activeRef.current) {
      void stop()
    } else {
      void start()
    }
  }, [enabled, start, stop])

  const handleShortcut = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!enabled || !shortcut.trim()) return false
    // This is intentionally a focused-composer binding, not a global OS
    // listener. cc-shell already owns the text target, so stealing a global
    // hotkey would be surprising while users are typing elsewhere. Caveat:
    // macOS `Fn` is only reliably observable through the native helper used by
    // the standalone app. We keep `Fn` as the default stored value because that
    // is the product default, but true app-wide/bare-Fn behavior requires a
    // main-process helper port rather than a renderer keydown listener.
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
