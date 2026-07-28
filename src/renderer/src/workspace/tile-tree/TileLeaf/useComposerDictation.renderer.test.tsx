import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import { useComposerDictation } from './useComposerDictation'
import type { ComposerDictationController } from './useComposerDictation'

// Regression net for the cold-start audio-loss bug.
//
// The bug: `dataavailable` handling dropped any blob of <= 1 byte. A
// MediaRecorder blob is a slice of ONE continuous muxed byte stream — there is
// no per-blob framing, so the concatenation of every blob IS the WebM file, and
// dropping a non-empty blob deletes bytes out of the middle of the container.
// On a cold encoder the first 120 ms timeslice lands mid-header and yields
// exactly a 1-byte blob, so the FIRST dictation of every app run shipped a
// headerless stream and Deepgram rejected the whole recording as "corrupt or
// unsupported data". The second press warmed the encoder and worked, which is
// what made this look like an unfixable warm-up race for months.
//
// WHY these assertions are about BYTES DELIVERED rather than "a chunk was
// sent": an existence-only assertion passes while the leading byte is missing.
// That is precisely how the bug shipped and survived review. The test asserts
// the exact byte sequence main receives, in order, including the 1-byte chunk.

const MIN_HOLD_TO_TRANSCRIBE_MS = 180

type CapturedChunk = number[]

function bytes(size: number, fill: number): Uint8Array {
  return new Uint8Array(Array.from({ length: size }, () => fill))
}

/** Minimal MediaRecorder fake. `dataavailable` is driven by hand so a test can
 *  reproduce the cold-encoder timeslice pattern deterministically. */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  state: 'inactive' | 'recording' = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  private listeners = new Map<string, Array<(event: unknown) => void>>()

  constructor() {
    FakeMediaRecorder.instances.push(this)
  }

  static isTypeSupported(): boolean {
    return true
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler])
  }

  start(): void {
    this.state = 'recording'
  }

  requestData(): void {}

  stop(): void {
    this.state = 'inactive'
    for (const handler of this.listeners.get('stop') ?? []) handler({})
  }

  emit(payload: Uint8Array): void {
    const buffer = payload.slice().buffer
    const blob = {
      size: payload.byteLength,
      type: this.mimeType,
      arrayBuffer: async () => buffer,
    }
    for (const handler of this.listeners.get('dataavailable') ?? []) handler({ data: blob })
  }
}

let captured: CapturedChunk[] = []
let controller: ComposerDictationController | null = null

function Harness(): React.JSX.Element {
  controller = useComposerDictation({
    enabled: true,
    focused: true,
    provider: 'deepgram',
    shortcut: '',
    sink: { kind: 'composer', sessionId: 'session-1', input: '', setInputText: () => {} },
    onMessage: () => {},
  })
  return <div />
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  captured = []
  controller = null
  FakeMediaRecorder.instances = []

  const track = {
    label: 'MacBook Air Microphone (Built-in)',
    enabled: true,
    muted: false,
    readyState: 'live',
    stop: () => {},
  }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal(
    'AudioContext',
    class {
      sampleRate = 48000
      createMediaStreamSource(): unknown {
        return { connect: () => {} }
      }
      createAnalyser(): unknown {
        return {
          fftSize: 1024,
          frequencyBinCount: 512,
          minDecibels: 0,
          maxDecibels: 0,
          smoothingTimeConstant: 0,
          getByteFrequencyData: () => {},
        }
      }
      resume(): Promise<void> {
        return Promise.resolve()
      }
      close(): Promise<void> {
        return Promise.resolve()
      }
    },
  )
  // The meter is irrelevant to chunk delivery; keep it from scheduling frames.
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => stream,
      enumerateDevices: async () => [
        { kind: 'audioinput', label: 'MacBook Air Microphone (Built-in)', deviceId: 'builtin' },
      ],
    },
  })

  ;(window as unknown as { api: unknown }).api = {
    recordDictationDebugEvent: () => {},
    startDictationStream: async () => ({ kind: 'started', id: 'stream-1' }),
    pushDictationChunk: async (params: { id: string; chunk: ArrayBuffer }) => {
      captured.push([...new Uint8Array(params.chunk)])
      return { kind: 'ok' }
    },
    stopDictationStream: async () => ({ kind: 'no-speech' }),
    cancelDictationStream: async () => ({ kind: 'ok' }),
    onDictationStreamTranscript: () => () => {},
    // The shared hold registry subscribes to the native hotkey channel the
    // moment any dictation target registers, so these must exist even though
    // this test drives the recorder through `toggle()` rather than the hotkey.
    onDictationHotkeyDown: () => () => {},
    onDictationHotkeyUp: () => () => {},
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('composer dictation chunk delivery', () => {
  it('forwards a 1-byte cold-start chunk instead of dropping it', async () => {
    render(
      <SessionFeedProvider value={createFakeSessionFeed()}>
        <Harness />
      </SessionFeedProvider>,
    )

    await act(async () => {
      controller?.toggle()
    })

    const recorder = FakeMediaRecorder.instances[0]
    expect(recorder).toBeDefined()

    // The cold-encoder pattern, taken verbatim from journal 39c3a5d5: a 1-byte
    // first timeslice (the head of the EBML header) followed by a normal
    // cluster. Pre-fix, chunk 0 was dropped and the stream began at chunk 1.
    await act(async () => {
      recorder!.emit(bytes(1, 0x1a))
      recorder!.emit(bytes(4, 0x45))
    })

    // Chunks queue locally until the press is old enough to be a real dictation
    // attempt (the accidental-tap window), then drain in recorder order.
    await act(async () => {
      await wait(MIN_HOLD_TO_TRANSCRIBE_MS + 120)
    })

    expect(captured).toEqual([
      [0x1a],
      [0x45, 0x45, 0x45, 0x45],
    ])
  })

  it('still skips genuinely empty chunks', async () => {
    render(
      <SessionFeedProvider value={createFakeSessionFeed()}>
        <Harness />
      </SessionFeedProvider>,
    )

    await act(async () => {
      controller?.toggle()
    })
    const recorder = FakeMediaRecorder.instances[0]

    await act(async () => {
      recorder!.emit(bytes(0, 0))
      recorder!.emit(bytes(2, 0x99))
    })
    await act(async () => {
      await wait(MIN_HOLD_TO_TRANSCRIBE_MS + 120)
    })

    // A zero-byte blob contributes nothing to the container, so skipping it is
    // the one safe case — concatenating nothing is a no-op.
    expect(captured).toEqual([[0x99, 0x99]])
  })
})
