import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

// #1015: at startup the dev app warned "11 goal-loop:changed listeners added
// to [IpcRenderer]. MaxListeners is 10", and the same for
// dictation:stream-transcript. It is not a leak: every mounted pane
// subscribes once (GoalLoopPane, the composer's dictation hook) and cleans up.
// But each subscription was its own ipcRenderer listener, so 11 panes crossed
// Node's warning threshold, and that noise hides the next real leak.
//
// ipcRenderer is a real EventEmitter here, so listenerCount and the
// MaxListeners warning behave exactly as in Electron's renderer.
const ipc = vi.hoisted(() => ({ renderer: null as unknown as EventEmitter }))
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  ipc.renderer = new Emitter()
  return { ipcRenderer: ipc.renderer }
})

const { goalLoopApi } = await import('./goalLoop.js')
const { dictationApi } = await import('./dictation.js')

afterEach(() => { vi.restoreAllMocks() })

describe.each([
  ['goal-loop:changed', (cb: (payload: unknown) => void) => goalLoopApi.onGoalLoopChanged(() => cb(undefined))],
  ['dictation:stream-transcript', (cb: (payload: unknown) => void) => dictationApi.onDictationStreamTranscript(cb as never)],
])('%s', (channel, subscribe) => {
  it('many panes share ONE ipcRenderer listener, every pane still hears every event, and the last unsubscribe removes it', () => {
    const warning = vi.fn()
    process.on('warning', warning)
    const received = Array.from({ length: 12 }, () => vi.fn())
    const unsubscribes = received.map(cb => subscribe(cb))
    expect(ipc.renderer.listenerCount(channel)).toBe(1)

    ipc.renderer.emit(channel, {}, { sessionId: 's1' })
    for (const cb of received) expect(cb).toHaveBeenCalledTimes(1)

    unsubscribes.slice(0, 11).forEach(unsubscribe => unsubscribe())
    expect(ipc.renderer.listenerCount(channel)).toBe(1)
    unsubscribes[11]!()
    expect(ipc.renderer.listenerCount(channel)).toBe(0)
    process.off('warning', warning)
    expect(warning).not.toHaveBeenCalled()
  })

  it('one subscriber that throws does not starve the others', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const after = vi.fn()
    const off1 = subscribe(() => { throw new Error('pane crashed') })
    const off2 = subscribe(after)
    ipc.renderer.emit(channel, {}, {})
    expect(after).toHaveBeenCalledTimes(1)
    off1(); off2()
  })
})
