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

  /**
   * Emit one timeslice.
   *
   * `deferred: true` withholds the Blob→ArrayBuffer conversion until the
   * returned `release()` is called. That is the whole point of the fake: the
   * real bug class here is that `dataavailable` fires IN ORDER but
   * `blob.arrayBuffer()` is async and does not preserve that order, so a later
   * chunk's conversion can win the race and reach the wire first — which is
   * what produced Deepgram's `UNPARSABLE_CLIENT_MESSAGE` (a media cluster
   * arriving before the EBML init segment). A fake that always resolves
   * immediately cannot express that, and a test built on one silently passes
   * even with the `chunkChain` serialization deleted.
   */
  emit(payload: Uint8Array, options: { deferred?: boolean } = {}): { release: () => void } {
    const buffer = payload.slice().buffer
    let release = (): void => {}
    const ready = options.deferred
      ? new Promise<void>(resolve => {
          release = () => resolve()
        })
      : Promise.resolve()
    const blob = {
      size: payload.byteLength,
      type: this.mimeType,
      arrayBuffer: async () => {
        await ready
        return buffer
      },
    }
    for (const handler of this.listeners.get('dataavailable') ?? []) handler({ data: blob })
    return { release }
  }
}

let captured: CapturedChunk[] = []
let controller: ComposerDictationController | null = null
/** When set, the first `pushDictationChunk` blocks on this until resolved. */
let holdFirstPush: Promise<void> | null = null

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
  holdFirstPush = null
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
      // Record at CALL time — that is the order main would receive them in.
      captured.push([...new Uint8Array(params.chunk)])
      // `holdFirstPush` lets a test freeze the drain loop mid-flight so it can
      // emit a chunk while the queue is still draining. That window is the only
      // place the drain-then-publish ordering bug is observable.
      if (holdFirstPush && captured.length === 1) await holdFirstPush
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

  it('preserves recorder order when an earlier chunk converts late', async () => {
    // Pins the `chunkChain` serialization. `dataavailable` fires in order but
    // `blob.arrayBuffer()` is async, so without the chain a later chunk whose
    // conversion resolves first reaches the wire first — the WebM stream then
    // begins with a media cluster instead of the EBML init segment and Deepgram
    // rejects it as UNPARSABLE_CLIENT_MESSAGE.
    render(
      <SessionFeedProvider value={createFakeSessionFeed()}>
        <Harness />
      </SessionFeedProvider>,
    )

    await act(async () => {
      controller?.toggle()
    })
    const recorder = FakeMediaRecorder.instances[0]

    // Chunk 0 (the header) converts LATE; chunk 1 converts immediately.
    let releaseHeader = (): void => {}
    await act(async () => {
      releaseHeader = recorder!.emit(bytes(3, 0x1a), { deferred: true }).release
      recorder!.emit(bytes(2, 0x42))
    })

    await act(async () => {
      releaseHeader()
      await wait(MIN_HOLD_TO_TRANSCRIBE_MS + 120)
    })

    // Recorder order, not conversion order.
    expect(captured).toEqual([
      [0x1a, 0x1a, 0x1a],
      [0x42, 0x42],
    ])
  })

  it('keeps order across the queued-to-direct handover once the stream is open', async () => {
    // The queued path (before the provider session exists) and the direct
    // push-ipc path (after `recording.id` is published) are different branches.
    // The handover between them is where the drain-then-publish ordering fix
    // lives: publishing the id BEFORE the queue is empty lets a concurrent
    // chunk jump ahead of the queued ones.
    render(
      <SessionFeedProvider value={createFakeSessionFeed()}>
        <Harness />
      </SessionFeedProvider>,
    )

    await act(async () => {
      controller?.toggle()
    })
    const recorder = FakeMediaRecorder.instances[0]

    // Freeze the drain after its first push so a new chunk can arrive while the
    // queue is still non-empty. Publishing `recording.id` before the queue
    // empties would let that chunk take the direct branch and overtake the
    // still-queued one.
    let releaseDrain = (): void => {}
    holdFirstPush = new Promise<void>(resolve => {
      releaseDrain = () => resolve()
    })

    await act(async () => {
      recorder!.emit(bytes(1, 0x01))
      recorder!.emit(bytes(1, 0x02))
    })
    // Let the tap window elapse so the stream opens and the drain begins.
    await act(async () => {
      await wait(MIN_HOLD_TO_TRANSCRIBE_MS + 120)
    })
    // Mid-drain: chunk 0x03 arrives while 0x02 is still queued.
    await act(async () => {
      recorder!.emit(bytes(1, 0x03))
      await wait(20)
    })
    await act(async () => {
      releaseDrain()
      await wait(80)
    })
    // And a chunk after the handover completes, on the direct branch.
    await act(async () => {
      recorder!.emit(bytes(1, 0x04))
      await wait(50)
    })

    expect(captured).toEqual([[0x01], [0x02], [0x03], [0x04]])
  })
})
