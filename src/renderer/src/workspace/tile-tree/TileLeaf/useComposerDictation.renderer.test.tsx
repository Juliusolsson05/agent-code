import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import { useComposerDictation } from './useComposerDictation'
import { useAppStore } from '@renderer/app-state/store'
import type { ComposerDictationController } from './useComposerDictation'
import { beginDictationHold, endDictationHold } from './dictationHotkeyRegistry'

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
const onMessage = vi.fn()

function Harness({ terminal = false }: { terminal?: boolean }): React.JSX.Element {
  controller = useComposerDictation({
    enabled: true,
    focused: true,
    provider: 'deepgram',
    shortcut: '',
    sink: terminal
      ? { kind: 'terminal', sessionId: 'session-1' }
      : { kind: 'composer', sessionId: 'session-1', input: '', setInputText: () => {} },
    onMessage,
  })
  return <div />
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  useAppStore.getState().setSettings({ dictationAudioInput: null })
  onMessage.mockClear()
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
      getUserMedia: vi.fn(async () => stream),
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
  useAppStore.getState().setSettings({ dictationAudioInput: null })
  vi.unstubAllGlobals()
})

describe('configured dictation microphone', () => {
  it.each([false, true])('uses the latest selection at capture start (terminal: %s)', async terminal => {
    const mount = () => render(
      <SessionFeedProvider value={createFakeSessionFeed()}><Harness terminal={terminal} /></SessionFeedProvider>,
    )
    const view = mount()
    // Set after mount: a callback that captured the initial preference would
    // pass a fresh-mount test but fail when Settings changes on a live pane.
    await act(async () => {
      useAppStore.getState().setSettings({ dictationAudioInput: { deviceId: 'headset', label: 'USB Headset' } })
      controller?.toggle()
    })
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: 'headset' } } })
    const calls = vi.mocked(navigator.mediaDevices.getUserMedia).mock.calls.length
    await act(async () => {
      useAppStore.getState().setSettings({ dictationAudioInput: { deviceId: 'default', label: 'System default' } })
    })
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(calls)
    expect(FakeMediaRecorder.instances[0]?.state).toBe('recording')
    view.unmount()
    const next = mount()
    await act(async () => { controller?.toggle() })
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenLastCalledWith({ audio: true })
    next.unmount()
  })

  it('reports a disconnected selected microphone without recording from a fallback', async () => {
    render(<SessionFeedProvider value={createFakeSessionFeed()}><Harness /></SessionFeedProvider>)
    // Let any one-time prewarm finish before rejecting the real capture.
    await act(async () => {})
    useAppStore.getState().setSettings({ dictationAudioInput: { deviceId: 'gone', label: 'USB Headset' } })
    vi.mocked(navigator.mediaDevices.getUserMedia).mockClear()
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new DOMException('', 'OverconstrainedError'))
    await act(async () => { controller?.toggle() })
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('USB Headset'))
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('Settings → Dictation'))
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce()
    expect(FakeMediaRecorder.instances).toHaveLength(0)
  })
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

// #243: every dictation ends with exactly one OUTCOME row carrying a code, and
// the user reads the code's sentence. Timings come from the owner's recorded
// journals (testing/fixtures/dictation/lifecycle-sessions-2026-09.json).
describe('dictation outcome codes (#243)', () => {
  type Row = { tMs: number; layer: string; event: string; data?: Record<string, unknown> }
  const recorded = JSON.parse(readFileSync(join(import.meta.dirname,
    '../../../../../../testing/fixtures/dictation/lifecycle-sessions-2026-09.json'), 'utf8')) as {
    sessions: Record<string, { rows: Row[] }>
  }
  const at = (session: string, event: string) => recorded.sessions[session]!.rows.find(row => row.event === event)!
  let journal: Array<{ layer: string; event: string; data?: Record<string, unknown> }> = []
  const outcomes = () => journal.filter(row => row.layer === 'OUTCOME')
  const mount = () => render(<SessionFeedProvider value={createFakeSessionFeed()}><Harness /></SessionFeedProvider>)
  let streamStarts: ReturnType<typeof vi.fn>
  beforeEach(() => {
    journal = []
    const api = (window as unknown as { api: { recordDictationDebugEvent: unknown; startDictationStream: (...args: unknown[]) => unknown } }).api
    api.recordDictationDebugEvent =
      (_id: string, row: { layer: string; event: string; data?: Record<string, unknown> }) => { journal.push(row) }
    // Counted, so a test can release only once the stream has really been
    // asked to start. A fixed delay raced the hook's 180 ms accidental-tap
    // timer under load and ended the recording as too-short instead.
    const start = api.startDictationStream
    streamStarts = vi.fn((...args: unknown[]) => start(...args))
    api.startDictationStream = streamStarts
  })
  /** Emit one chunk and wait until the hook has asked main to start the stream. */
  const speak = async () => {
    await act(async () => { FakeMediaRecorder.instances.at(-1)!.emit(bytes(8, 1)) })
    await act(async () => { await vi.waitFor(() => expect(streamStarts).toHaveBeenCalled(), { timeout: 3_000 }); await wait(20) })
  }
  afterEach(() => { vi.useRealTimers() })
  const slowMicrophone = (ms: number) => {
    const real = vi.mocked(navigator.mediaDevices.getUserMedia).getMockImplementation()!
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async constraints => {
      await wait(ms)
      return real(constraints)
    })
  }

  // Recorded: released at 49 ms while getUserMedia (190 ms) was still opening.
  // start() discarded it and wrote nothing; 13 recorded sessions ended so.
  it('records a tap released while the microphone opens as cancelled.short-press', async () => {
    const releasedAt = at('tap-while-starting', 'stop:called').tMs
    const micMs = at('tap-while-starting', 'start:get-user-media:done').data!.ms as number
    mount()
    await act(async () => {})
    slowMicrophone(micMs)
    await act(async () => { beginDictationHold('keyboard') })
    await act(async () => { await wait(releasedAt); endDictationHold() })
    await act(async () => { await wait(micMs + 50) })
    expect(outcomes()).toEqual([expect.objectContaining({ event: 'cancel', data: expect.objectContaining({ code: 'cancelled.short-press' }) })])
    expect(onMessage).not.toHaveBeenCalled()
  })

  // Recorded: the key was held 3.35 s, but getUserMedia took 3,280 ms of it, the
  // recorder ran 60 ms and captured nothing, and the user was told "No speech
  // detected". The speech happened before the microphone was open.
  it('says the microphone opened late instead of "No speech detected"', async () => {
    const micMs = at('mic-opened-late', 'start:get-user-media:done').data!.ms as number
    mount()
    await act(async () => {})
    slowMicrophone(micMs)
    await act(async () => { beginDictationHold('keyboard') })
    // Released while the microphone was still opening, as recorded.
    await act(async () => { await wait(at('mic-opened-late', 'stop:called').tMs); endDictationHold() })
    await act(async () => { await wait(micMs) })
    expect(outcomes()).toEqual([expect.objectContaining({ event: 'error', data: expect.objectContaining({ code: 'mic.opened-late' }) })])
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining(`the microphone took ${(micMs / 1000).toFixed(1)} s to open`))
    expect(onMessage).not.toHaveBeenCalledWith('No speech detected')
  }, 10_000)

  // Recorded: the selected EarPods were unplugged (OverconstrainedError).
  it('records an unavailable microphone as mic.unavailable', async () => {
    const name = at('mic-unavailable', 'start:get-user-media:error').data!.name as string
    mount()
    await act(async () => {})
    useAppStore.getState().setSettings({ dictationAudioInput: { deviceId: 'gone', label: 'EarPods Microphone (05ac:110b)' } })
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(new DOMException('', name))
    await act(async () => { controller?.toggle() })
    expect(outcomes()).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'mic.unavailable' }) })])
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('EarPods Microphone'))
  })

  // First-audio deadline: the recorded maximum is 626 ms; a recorder that
  // produces nothing for 2 s is a capture failure, not silence.
  it('ends a recording whose microphone produces no audio within the first-audio deadline', async () => {
    mount()
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    expect(FakeMediaRecorder.instances.at(-1)?.state).toBe('recording')
    await act(async () => { await wait(2_100) })
    expect(outcomes()).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'recorder.no-audio' }) })])
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('produced no audio'))
    expect(FakeMediaRecorder.instances.at(-1)?.state).toBe('inactive')
  })

  // Connect deadline: the recorded maximum is 55 ms; a stream-start that never
  // answers (main's keychain read hangs) must end the recording, not leave a
  // pill that never resolves.
  it('ends a recording whose stream never starts within the connect deadline', async () => {
    streamStarts.mockImplementation(() => new Promise(() => {}))
    // Fake timers that still follow real time, so the recorder and chunk
    // plumbing run as usual and only the 10 s deadline is fast-forwarded.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    mount()
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await speak()
    await act(async () => { vi.advanceTimersByTime(10_000); await wait(10) })
    expect(outcomes()).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'connect.timeout' }) })])
    expect(onMessage).toHaveBeenCalledWith('Dictation could not start in time. Try again.')
  })

  // Main's answer: the sentence comes from its code, never its text.
  it('shows the code’s sentence for a provider failure, not main’s text', async () => {
    ;(window as unknown as { api: { stopDictationStream: unknown } }).api.stopDictationStream =
      async () => ({ kind: 'error', reason: 'provider.bad-audio', message: 'Deepgram transcription failed' })
    mount()
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await speak()
    await act(async () => { controller?.toggle(); await wait(20) })
    expect(onMessage).toHaveBeenCalledWith('Deepgram could not process this recording. Try again.')
    expect(onMessage).not.toHaveBeenCalledWith('Deepgram transcription failed')
  })

  // #1340 review A1 (q22/q39): an error name the mapping does not know must
  // not put the browser's own text in front of the user.
  it('never shows an unknown microphone error’s own text', async () => {
    mount()
    await act(async () => {})
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BROWSER_TOKEN'), { name: 'UnknownError' }))
    await act(async () => { controller?.toggle() })
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage.mock.calls[0]![0]).not.toContain('PRIVATE_BROWSER_TOKEN')
    expect(outcomes()).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'mic.error' }) })])
  })

  // #1340 review A2: unmounted while the microphone is still opening. The
  // late stream must be closed, no recorder built, and the session end with
  // one cancelled.unmount row.
  it('closes a microphone that opens after the pane unmounted', async () => {
    const view = mount()
    await act(async () => {})
    slowMicrophone(200)
    const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = []
    const real = vi.mocked(navigator.mediaDevices.getUserMedia).getMockImplementation()!
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(async constraints => {
      const stream = await real(constraints) as unknown as { getTracks: () => Array<{ stop: () => void }> }
      const track = { ...stream.getTracks()[0]!, stop: vi.fn() }
      tracks.push(track)
      return { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
    })
    await act(async () => { controller?.toggle() })
    await act(async () => { await wait(10); view.unmount() })
    await act(async () => { await wait(300) })
    expect(FakeMediaRecorder.instances).toHaveLength(0)
    expect(tracks.every(track => track.stop.mock.calls.length > 0)).toBe(true)
    expect(outcomes()).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'cancelled.unmount' }) })])
  })

  // #1340 review A (survivor): unmount while recording writes its OUTCOME.
  it('records cancelled.unmount when the pane goes away mid-recording', async () => {
    const view = mount()
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await act(async () => { view.unmount() })
    expect(outcomes()).toEqual([expect.objectContaining({ layer: 'OUTCOME', data: expect.objectContaining({ code: 'cancelled.unmount' }) })])
  })

  // #1340 review A4: released while the stream start is pending, then the
  // connect deadline fires. One ending, one sentence.
  it('ends a recording once when the connect deadline fires during a stop', async () => {
    streamStarts.mockImplementation(() => new Promise(() => {}))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    mount()
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await speak()
    await act(async () => { controller?.toggle(); await wait(10) })
    await act(async () => { vi.advanceTimersByTime(10_000); await wait(10) })
    expect(onMessage.mock.calls.map(call => call[0])).toEqual(['Dictation could not start in time. Try again.'])
    expect(outcomes()).toHaveLength(1)
  })

  // #1340 review A (survivor): main never answered (the stop IPC threw), so
  // the renderer writes the row.
  it('records an outcome when the stop IPC throws', async () => {
    ;(window as unknown as { api: { stopDictationStream: unknown } }).api.stopDictationStream = async () => { throw new Error('ipc gone') }
    mount()
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await speak()
    await act(async () => { controller?.toggle(); await wait(20) })
    expect(outcomes()).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'unknown' }) })])
    expect(onMessage).toHaveBeenCalledWith('Dictation failed.')
  })

  // #1340 review C: a chunk push that never settles used to strand the
  // recording in "stopping" before main's final timer existed.
  it('bounds a stop whose chunk push never settles', async () => {
    ;(window as unknown as { api: { pushDictationChunk: unknown } }).api.pushDictationChunk = () => new Promise(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    mount()
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await speak()
    await act(async () => { FakeMediaRecorder.instances.at(-1)!.emit(bytes(8, 2)); await wait(20) })
    await act(async () => { controller?.toggle(); await wait(10) })
    await act(async () => { vi.advanceTimersByTime(10_000); await wait(10) })
    expect(outcomes()).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'final.timeout' }) })])
    expect(controller?.status).not.toBe('stopping')
  })

  // #1340 review C: terminal insertion is an async session write that can
  // answer false. `committed` must wait for it, and a failed paste is a
  // delivery.failed row the user is told about, not a silent success.
  it.each([
    ['answers false', (feed: ReturnType<typeof createFakeSessionFeed>) => { feed.nextSendInputResult = false }],
    ['rejects', (feed: ReturnType<typeof createFakeSessionFeed>) => { feed.sendInput = async () => { throw new Error('gone') } }],
  ])('reports a terminal paste that %s instead of logging it committed', async (_label, arrange) => {
    ;(window as unknown as { api: { stopDictationStream: unknown } }).api.stopDictationStream =
      async () => ({ kind: 'success', raw: 'hello', text: '<stt>hello</stt>', provider: 'deepgram', audioBytes: 8, chunkCount: 1, sttMs: 5 })
    const feed = createFakeSessionFeed()
    arrange(feed)
    render(<SessionFeedProvider value={feed}><Harness terminal /></SessionFeedProvider>)
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await speak()
    await act(async () => { controller?.toggle(); await wait(30) })
    expect(journal.some(row => row.layer === 'TRANSCRIPT' && row.event === 'committed')).toBe(false)
    expect(journal).toContainEqual(expect.objectContaining({ layer: 'TRANSCRIPT', event: 'delivery:failed', data: { code: 'delivery.failed' } }))
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining('could not be sent to the terminal'))
  })

  // #1340 round 2 C: main started the stream, but the queued first chunk's
  // push never settled, so the drain never published the id. The drain
  // deadline must still cancel main's half of the session.
  it('cancels main’s stream when the queued drain times out before the id is published', async () => {
    const api = window as unknown as { api: { pushDictationChunk: unknown; cancelDictationStream: unknown } }
    api.api.pushDictationChunk = () => new Promise(() => {})
    const cancel = vi.fn(async () => ({ kind: 'ok' }))
    api.api.cancelDictationStream = cancel
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    mount()
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await speak()
    await act(async () => { controller?.toggle(); await wait(10) })
    await act(async () => { vi.advanceTimersByTime(10_000); await wait(10) })
    expect(outcomes()).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'final.timeout' }) })])
    expect(cancel).toHaveBeenCalledWith({ id: 'stream-1' })
  })

  // #1340 round 2 C: unmounted while devices are being enumerated; no
  // microphone may be requested afterwards.
  it('asks for no microphone when the pane unmounts during device enumeration', async () => {
    const view = mount()
    await act(async () => {})
    let release!: () => void
    const enumerated = new Promise<void>(resolve => { release = resolve })
    const devices = navigator.mediaDevices as unknown as { enumerateDevices: () => Promise<unknown[]> }
    const real = devices.enumerateDevices
    devices.enumerateDevices = async () => { await enumerated; return real() }
    vi.mocked(navigator.mediaDevices.getUserMedia).mockClear()
    await act(async () => { controller?.toggle() })
    await act(async () => { view.unmount() })
    await act(async () => { release(); await wait(20) })
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled()
    expect(outcomes()).toEqual([expect.objectContaining({ data: expect.objectContaining({ code: 'cancelled.unmount' }) })])
  })

  // Terminal success (#1340 round 2 C survivor): the paste is attempted with
  // bracketed paste and `committed` is written only once it answers true.
  it('pastes into the terminal and logs committed once the write succeeds', async () => {
    ;(window as unknown as { api: { stopDictationStream: unknown } }).api.stopDictationStream =
      async () => ({ kind: 'success', raw: 'hello', text: '<stt>hello</stt>', provider: 'deepgram', audioBytes: 8, chunkCount: 1, sttMs: 5 })
    const feed = createFakeSessionFeed()
    render(<SessionFeedProvider value={feed}><Harness terminal /></SessionFeedProvider>)
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await speak()
    await act(async () => { controller?.toggle(); await wait(30) })
    expect(feed.calls).toContainEqual(expect.objectContaining({ method: 'sendInput', sessionId: 'session-1', data: '\x1b[200~<stt>hello</stt>\x1b[201~' }))
    expect(journal.some(row => row.layer === 'TRANSCRIPT' && row.event === 'committed')).toBe(true)
    expect(onMessage).not.toHaveBeenCalled()
  })

  // #1340 round 2 C: dictation A's paste times out while dictation B is
  // already recording. A's failure is still reported, named as the
  // previous transcript, not as B's.
  it('names a late terminal-delivery failure as the previous transcript', async () => {
    ;(window as unknown as { api: { stopDictationStream: unknown } }).api.stopDictationStream =
      async () => ({ kind: 'success', raw: 'hello', text: '<stt>hello</stt>', provider: 'deepgram', audioBytes: 8, chunkCount: 1, sttMs: 5 })
    const feed = createFakeSessionFeed()
    feed.sendInput = () => new Promise(() => {})
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    render(<SessionFeedProvider value={feed}><Harness terminal /></SessionFeedProvider>)
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await speak()
    await act(async () => { controller?.toggle(); await wait(30) })
    // B starts, and is producing audio, before A's 5 s insertion deadline.
    await act(async () => { controller?.toggle(); await wait(20) })
    await speak()
    expect(controller?.status).toBe('recording')
    await act(async () => { vi.advanceTimersByTime(5_000); await wait(10) })
    expect(onMessage).toHaveBeenCalledWith('The previous transcript could not be sent to the terminal. It is in Settings → Dictation → History.')
    expect(controller?.status).toBe('recording')
  })
})
