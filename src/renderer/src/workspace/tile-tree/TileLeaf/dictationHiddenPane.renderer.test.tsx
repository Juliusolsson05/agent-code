import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import { useComposerDictation } from './useComposerDictation'
import { useAppStore } from '@renderer/app-state/store'
import {
  beginDictationHold,
  cancelDictationHold,
} from '@renderer/workspace/tile-tree/TileLeaf/dictationHotkeyRegistry'
import type { ComposerDictationController } from './useComposerDictation'

// ---------------------------------------------------------------------------
// #916. Opening Settings mid-dictation silently threw away everything the user
// had said — including when they opened Settings to look at the dictation
// configuration.
//
// `MainSurface` hides the RETAINED workspace surface for Settings, Reader and
// Spotlight; the owning pane then passes `enabled: false`. That effect used to
// stop the tracks, restore the base draft, mark the recording discarded and
// CANCEL the provider stream.
//
// Retained means still mounted, so the recording can be finished rather than
// discarded — which is what these pin. Driven through the real hook with a
// real (fake) MediaRecorder, because the bug lives in an effect that fires on a
// prop change and nothing below the hook can observe it.
// ---------------------------------------------------------------------------

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = []
  state: 'inactive' | 'recording' = 'inactive'
  mimeType = 'audio/webm;codecs=opus'
  private listeners = new Map<string, Array<(event: unknown) => void>>()
  constructor() { FakeMediaRecorder.instances.push(this) }
  static isTypeSupported(): boolean { return true }
  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler])
  }
  start(): void { this.state = 'recording' }
  requestData(): void {}
  stop(): void {
    this.state = 'inactive'
    for (const handler of this.listeners.get('stop') ?? []) handler({})
  }

  /** One timeslice. The provider stream only opens once audio actually
   *  arrives, so a fake that never emits produces a recording with no stream
   *  id — and every assertion below would pass for the wrong reason. */
  emit(payload: Uint8Array): void {
    const buffer = payload.slice().buffer
    const blob = { size: payload.byteLength, type: this.mimeType, arrayBuffer: async () => buffer }
    for (const handler of this.listeners.get('dataavailable') ?? []) handler({ data: blob })
  }
}

let controller: ComposerDictationController | null = null
let draft = ''
let stopped: Array<{ id: string }> = []
let cancelled: Array<{ id: string }> = []
let transcript = 'the words the user actually said'
let streamsStarted = 0
let messages: string[] = []
let feed: ReturnType<typeof createFakeSessionFeed>

function Harness({ enabled, terminal = false }: { enabled: boolean; terminal?: boolean }): React.JSX.Element {
  controller = useComposerDictation({
    enabled,
    focused: true,
    provider: 'deepgram',
    shortcut: '',
    sink: terminal
      ? { kind: 'terminal', sessionId: 'session-1' }
      : {
          kind: 'composer',
          sessionId: 'session-1',
          input: draft,
          setInputText: (next: string) => { draft = next },
        },
    onMessage: (message: string) => { messages.push(message) },
  })
  return <div />
}

beforeEach(() => {
  useAppStore.getState().setSettings({ dictationAudioInput: null })
  controller = null
  draft = ''
  stopped = []
  cancelled = []
  transcript = 'the words the user actually said'
  streamsStarted = 0
  messages = []
  feed = createFakeSessionFeed()
  FakeMediaRecorder.instances = []

  const track = { label: 'Built-in', enabled: true, muted: false, readyState: 'live', stop: () => {} }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('AudioContext', class {
    sampleRate = 48000
    createMediaStreamSource(): unknown { return { connect: () => {} } }
    createAnalyser(): unknown {
      return { fftSize: 1024, frequencyBinCount: 512, minDecibels: 0, maxDecibels: 0, smoothingTimeConstant: 0, getByteFrequencyData: () => {} }
    }
    resume(): Promise<void> { return Promise.resolve() }
    close(): Promise<void> { return Promise.resolve() }
  })
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => stream),
      enumerateDevices: async () => [{ kind: 'audioinput', label: 'Built-in', deviceId: 'builtin' }],
    },
  })
  ;(window as unknown as { api: unknown }).api = {
    recordDictationDebugEvent: () => {},
    startDictationStream: async () => { streamsStarted += 1; return { kind: 'started', id: 'stream-1' } },
    pushDictationChunk: async () => ({ kind: 'ok' }),
    stopDictationStream: async (params: { id: string }) => {
      stopped.push(params)
      return { kind: 'success', text: transcript }
    },
    cancelDictationStream: async (params: { id: string }) => {
      cancelled.push(params)
      return { kind: 'ok' }
    },
    onDictationStreamTranscript: () => () => {},
    onDictationHotkeyDown: () => () => {},
    onDictationHotkeyUp: () => () => {},
  }
})

afterEach(() => {
  useAppStore.getState().setSettings({ dictationAudioInput: null })
  vi.unstubAllGlobals()
})

/** Start a recording and let the stream come up. */
async function recording(options: { terminal?: boolean } = {}) {
  const view = render(
    <SessionFeedProvider value={feed}>
      <Harness enabled terminal={options.terminal ?? false} />
    </SessionFeedProvider>,
  )
  await act(async () => {})
  await act(async () => { controller?.toggle() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(FakeMediaRecorder.instances.at(-1)?.state).toBe('recording')
  // Actually speak: the provider stream opens on the first timeslice, so
  // without this the recording has no stream id and every assertion below
  // would pass through the "No speech detected" path instead.
  await act(async () => {
    FakeMediaRecorder.instances.at(-1)?.emit(new Uint8Array([1, 2, 3, 4]))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  // Speak for longer than MIN_HOLD_TO_TRANSCRIBE_MS. A sub-180 ms recording is
  // treated as an accidental tap and discarded on ANY stop, which is correct
  // and not what this is about.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
  expect(streamsStarted).toBe(1)
  return view
}

/** Hide the owning pane, as opening Settings does. */
async function hide(view: ReturnType<typeof render>, options: { terminal?: boolean } = {}) {
  await act(async () => {
    view.rerender(
      <SessionFeedProvider value={feed}>
        <Harness enabled={false} terminal={options.terminal ?? false} />
      </SessionFeedProvider>,
    )
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('hiding the pane finishes the recording (#916)', () => {
  it('keeps the speech instead of discarding it', async () => {
    const view = await recording()
    await hide(view)

    // THE REGRESSION. This used to cancel the stream and restore the base
    // draft, so everything said between starting and opening Settings was
    // gone with no message.
    expect(cancelled).toEqual([])
    expect(stopped).toEqual([{ id: 'stream-1', audioDurationMs: expect.any(Number) }])
    expect(draft).toContain('the words the user actually said')
    view.unmount()
  })

  it('ends capture deterministically rather than leaving the microphone live', async () => {
    // The alternative #916 lists — keep recording while the user is elsewhere —
    // is the "orphaned capture ownership" it warns against, and a privacy
    // surprise besides. The recorder is stopped either way.
    const view = await recording()
    await hide(view)
    expect(FakeMediaRecorder.instances.at(-1)?.state).toBe('inactive')
    view.unmount()
  })

  it('still refuses to START while the pane is hidden', async () => {
    // The one guarantee that must survive: a hidden pane may finish what it
    // owned, never begin something new.
    //
    // Three guards enforce this — the hotkey registration, `toggle` and
    // `start` itself — and they MASK each other, so no single one can be
    // mutated and observed here. Removing both that this path crosses does
    // fail it, which is the honest statement of what is pinned.
    const view = render(
      <SessionFeedProvider value={feed}><Harness enabled={false} /></SessionFeedProvider>,
    )
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(FakeMediaRecorder.instances.filter(instance => instance.state === 'recording')).toEqual([])
    view.unmount()
  })

  it('the hold path really can start this hook, so the refusal above means something', async () => {
    // Paired with the test above on purpose. A negative assertion is only
    // worth having if the positive one fires, and an earlier version of the
    // hidden-hotkey case passed with EVERY guard removed — it never reached
    // `start` at all. This is the control: the same trigger, visible, does
    // start a recording.
    const view = render(
      <SessionFeedProvider value={feed}><Harness enabled /></SessionFeedProvider>,
    )
    await act(async () => {})
    await act(async () => {
      beginDictationHold()
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    expect(FakeMediaRecorder.instances.at(-1)?.state).toBe('recording')
    await act(async () => { cancelDictationHold() })
    view.unmount()
  })

  it('does nothing when there was no recording to finish', async () => {
    const view = render(
      <SessionFeedProvider value={feed}><Harness enabled /></SessionFeedProvider>,
    )
    await act(async () => {})
    await hide(view)
    expect(stopped).toEqual([])
    expect(cancelled).toEqual([])
    view.unmount()
  })

  it('reports no speech rather than inventing a draft', async () => {
    // Finishing is not a promise that something was heard. A silent recording
    // still restores the base draft, exactly as a deliberate stop does.
    ;(window as unknown as { api: { stopDictationStream: unknown } }).api.stopDictationStream =
      async (params: { id: string }) => { stopped.push(params); return { kind: 'no-speech' } }
    draft = 'what was already typed'
    const view = await recording()
    await hide(view)
    expect(draft).toBe('what was already typed')
    view.unmount()
  })
})

describe('a hidden TERMINAL pane is never pasted into (#1079 review, 4)', () => {
  // For a terminal sink `commitTranscript` is not a draft write: it sends
  // bracketed-paste BYTES to the PTY. Finishing into a hidden terminal pastes
  // into a shell the user cannot see — and bracketed paste only protects them
  // when the foreground program honours it, which a `read` prompt, a bare REPL
  // and an ssh session to an older host do not. An invisible pane is the worst
  // place to find that out.
  //
  // #916 names the terminal explicitly and this file had no terminal case at
  // all, so half the acceptance criteria was untested.
  it('does not send the transcript to the PTY', async () => {
    const view = await recording({ terminal: true })
    await hide(view, { terminal: true })

    expect(feed.calls.filter(call => call.method === 'sendInput')).toEqual([])
    view.unmount()
  })

  it('tells the user instead of discarding in silence', async () => {
    // #916's acceptance: "make any discard visible or explicit". Holding the
    // transcript and pasting it on return is the better answer and is a
    // follow-up; saying nothing is the one option that is not acceptable.
    const view = await recording({ terminal: true })
    await hide(view, { terminal: true })

    expect(messages.join(' ')).toMatch(/terminal pane was hidden/i)
    view.unmount()
  })

  it('still ends the capture, so no microphone is left live', async () => {
    const view = await recording({ terminal: true })
    await hide(view, { terminal: true })
    expect(FakeMediaRecorder.instances.at(-1)?.state).toBe('inactive')
    view.unmount()
  })

  it('DOES paste on a deliberate stop, so the refusal is about being hidden', async () => {
    // The control. Without it, "never sends" would pass for a hook that can
    // no longer send at all.
    const view = await recording({ terminal: true })
    await act(async () => { controller?.toggle() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(feed.calls.filter(call => call.method === 'sendInput')).toHaveLength(1)
    view.unmount()
  })
})

describe('a hidden finish does not overwrite what happened next (#1079 review, 2)', () => {
  it('appends to the CURRENT draft, not the pre-navigation snapshot', async () => {
    // The composer stays live and typable for the whole provider finalise
    // while the user is on another screen. Committing against
    // `recording.baseInput` destroyed anything typed since — the same class of
    // silent loss #916 is filed against, moved from speech to typing. It also
    // destroys a transcript from Spotlight's SECOND live leaf for this
    // session, which is not behind the retained surface at all.
    draft = ''
    const view = await recording()
    // The user leaves, comes back and types before the provider answers.
    await act(async () => {
      view.rerender(
        <SessionFeedProvider value={feed}><Harness enabled={false} /></SessionFeedProvider>,
      )
      draft = 'a note the user typed'
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(draft).toContain('a note the user typed')
    expect(draft).toContain('the words the user actually said')
    view.unmount()
  })
})

describe('hiding mid-START does not strand a live microphone (#1079 review, 1)', () => {
  // The case #916 names FIRST. `start()` can sit inside `getUserMedia` for
  // seconds, during which `activeRef` is still null. An `activeRef` guard on
  // the hide effect returned early there, the recorder came up afterwards in a
  // `display:none` pane, and NOTHING could stop it: the hotkey registration is
  // gone, `toggle` is shut, and the effect has already run.
  it('ends the capture that starts after the pane is hidden', async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    let release: () => void = () => {}
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return stream
    })

    const view = render(
      <SessionFeedProvider value={feed}><Harness enabled /></SessionFeedProvider>,
    )
    await act(async () => {})
    await act(async () => { controller?.toggle() })

    // Hidden while getUserMedia is still parked.
    await act(async () => {
      view.rerender(<SessionFeedProvider value={feed}><Harness enabled={false} /></SessionFeedProvider>)
    })
    await act(async () => {
      release()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    // No microphone may be left live in a pane nobody can see.
    expect(FakeMediaRecorder.instances.filter(instance => instance.state === 'recording')).toEqual([])
    view.unmount()
  })
})

describe('a discard on hide is never silent (#1079 review, 6)', () => {
  it('says so when the recording was too short to transcribe', async () => {
    // A 30 ms recording really does hold no speech, so discarding it is
    // right — but in silence it is exactly the complaint #916 was filed
    // about. A deliberate release explains itself; being hidden does not.
    const view = render(
      <SessionFeedProvider value={feed}><Harness enabled /></SessionFeedProvider>,
    )
    await act(async () => {})
    await act(async () => { controller?.toggle() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await act(async () => {
      FakeMediaRecorder.instances.at(-1)?.emit(new Uint8Array([1, 2, 3, 4]))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await hide(view)

    expect(messages.join(' ')).toMatch(/too short/i)
    view.unmount()
  })
})

describe('unmount during the finish writes nothing (#1079 review, 5)', () => {
  it('neither cancels the stream nor delivers the result', async () => {
    // The unmount cleanup used to cancel while `stop()` was mid-finalise, so
    // main deleted the session, the stop came back an error, and for a
    // terminal sink that error went to the GLOBAL overlay store — clobbering
    // whatever another pane had started.
    let finish: (value: unknown) => void = () => {}
    ;(window as unknown as { api: { stopDictationStream: unknown } }).api.stopDictationStream =
      async (params: { id: string }) => {
        stopped.push(params)
        return await new Promise(resolve => { finish = resolve })
      }

    const view = await recording({ terminal: true })
    await hide(view, { terminal: true })
    // The stop is in flight; the pane goes away underneath it.
    await act(async () => { view.unmount() })
    await act(async () => {
      finish({ kind: 'success', text: 'rm -rf everything' })
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(cancelled).toEqual([])
    expect(feed.calls.filter(call => call.method === 'sendInput')).toEqual([])
  })

  it('does not write to a composer whose pane is gone', async () => {
    // The terminal case above is caught one step earlier by the
    // never-deliver rule, so a composer sink is what pins the abandonment
    // guard itself: by the time the provider answers there is no draft left
    // to own, and writing anyway races the parent's teardown.
    let finish: (value: unknown) => void = () => {}
    ;(window as unknown as { api: { stopDictationStream: unknown } }).api.stopDictationStream =
      async (params: { id: string }) => {
        stopped.push(params)
        return await new Promise(resolve => { finish = resolve })
      }

    draft = 'what was already typed'
    const view = await recording()
    await hide(view)
    await act(async () => { view.unmount() })
    await act(async () => {
      finish({ kind: 'success', text: 'the words the user actually said' })
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(draft).toBe('what was already typed')
  })
})

describe('the hidden flag belongs to ONE attempt', () => {
  it('delivers normally on the next recording after the pane comes back', async () => {
    // The real sequence: dictate, open Settings, come back, dictate again. A
    // sticky `hidden` would make that second, entirely deliberate recording
    // refuse to deliver — the fix silently becoming the bug.
    const view = await recording({ terminal: true })
    await hide(view, { terminal: true })
    expect(feed.calls.filter(call => call.method === 'sendInput')).toEqual([])

    await act(async () => {
      view.rerender(<SessionFeedProvider value={feed}><Harness enabled terminal /></SessionFeedProvider>)
    })
    await act(async () => { controller?.toggle() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await act(async () => {
      FakeMediaRecorder.instances.at(-1)?.emit(new Uint8Array([1, 2, 3, 4]))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
    await act(async () => { controller?.toggle() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

    expect(feed.calls.filter(call => call.method === 'sendInput')).toHaveLength(1)
    view.unmount()
  })
})
