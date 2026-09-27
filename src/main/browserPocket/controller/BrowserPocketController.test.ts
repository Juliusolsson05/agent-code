import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { evaluateIsolated } from './actions'
import { BrowserPocketController, TAKEOVER_IDLE_RESUME_MS, type ActionCtx, type ControllerDeps, type GuestLike, type ImageLike } from './BrowserPocketController'
// This suite tests queue/lifecycle behavior independently of the page engine.
// Real actionability, refs and frames are covered by playwrightActions.system.
const readProbe = (ctx: ActionCtx) => ctx.cdp.sendCommand('Accessibility.getFullAXTree')

// The fake debugger answers with RECORDED Chrome responses (Stage-1
// fixtures): the real accessibility tree of the form page, and the recorded
// console/network event stream of the broken page. Only the
// wiring (which command returns which recording) is written here.
const FIX = join(__dirname, '..', '__fixtures__')
const axForm = JSON.parse(readFileSync(join(FIX, 'axtree.form.json'), 'utf8'))
const errorEvents = readFileSync(join(FIX, 'cdp-events.errors.jsonl'), 'utf8').trim().split('\n').slice(1).map(l => JSON.parse(l) as { method: string; params: unknown })

const EMPTY_IMAGE: ImageLike = { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), resize: () => EMPTY_IMAGE, toJPEG: () => Buffer.from('') }

function fakeGuest(opts: { hang?: string } = {}) {
  const listeners: Record<string, Array<(...a: any[]) => void>> = {}
  const sent: Array<{ method: string; params?: any }> = []
  let attached = false
  const dbg = {
    attach: vi.fn(() => { attached = true }),
    detach: vi.fn(() => { attached = false }),
    isAttached: () => attached,
    sendCommand: vi.fn(async (method: string, params?: any) => {
      sent.push({ method, params })
      if (method === opts.hang) return new Promise(() => {})
      if (method === 'Accessibility.getFullAXTree') return { nodes: axForm.nodes }
      return {}
    }),
    on: (event: string, listener: (...a: any[]) => void) => { (listeners[event] ??= []).push(listener) },
    removeListener: (event: string, listener: (...a: any[]) => void) => { listeners[event] = (listeners[event] ?? []).filter(l => l !== listener) },
  }
  let devtools = false
  const guest = {
    id: Math.floor(Math.random() * 1e6), debugger: dbg,
    isDestroyed: () => false, isDevToolsOpened: () => devtools,
    getURL: () => 'http://127.0.0.1:62678/form', getTitle: () => 'Sign in',
    loadURL: async () => {}, reload: () => {},
    capturePage: async (): Promise<ImageLike> => EMPTY_IMAGE,
    once: vi.fn(),
  } satisfies GuestLike
  return { guest, dbg, sent, emit: (method: string, params: unknown) => listeners.message?.forEach(l => l({}, method, params)), openDevTools: () => { devtools = true } }
}

function controller(overrides: Partial<ControllerDeps> = {}) {
  let t = 1_000
  const driving: unknown[] = []
  const requestOpen = vi.fn()
  const c = new BrowserPocketController({
    now: () => t, emitDriving: e => driving.push(e), requestOpen, setWatchedSessions: () => {}, lanePorts: () => [], requestViewport: () => {}, ...overrides,
  })
  c.setFlags({ enabled: true, allowEvaluate: false })
  return { c, driving, requestOpen, advance: (ms: number) => { t += ms } }
}

afterEach(() => vi.useRealTimers())

describe('targeting and gates', () => {
  it('a session with no pocket gets no_pocket; a disabled feature gets disabled', async () => {
    const { c } = controller()
    expect(await c.run('s1', 'status', async () => 1)).toMatchObject({ ok: false, code: 'no_pocket' })
    c.register('p1', 's1', fakeGuest().guest)
    c.setFlags({ enabled: false, allowEvaluate: false })
    expect(await c.run('s1', 'status', async () => 1)).toMatchObject({ ok: false, code: 'disabled' })
  })

  it('a session only ever reaches its own pocket', async () => {
    const { c } = controller()
    const a = fakeGuest(); const b = fakeGuest()
    c.register('pa', 'sa', a.guest); c.register('pb', 'sb', b.guest)
    await c.run('sa', 'snapshot', ctx => readProbe(ctx))
    expect(a.sent.some(s => s.method === 'Accessibility.getFullAXTree')).toBe(true)
    expect(b.sent).toEqual([])
  })

  it('after a SessionId remap (reload / provider switch) the new id owns the pocket and the old one does not', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 'old', g.guest)
    c.register('p1', 'new', g.guest)
    expect(await c.run('new', 'x', async () => 1)).toEqual({ ok: true, value: 1 })
    expect(await c.run('old', 'x', async () => 1)).toMatchObject({ code: 'no_pocket' })
  })
})

describe('agent actions on recorded Chrome responses', () => {
  it('replayed console/network stream is reported once, and "since last snapshot" only shows what is new', async () => {
    const { c, advance } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    await c.run('s1', 'attach', async () => 1)
    for (const e of errorEvents) g.emit(e.method, e.params)
    expect(c.networkSince('s1').map(n => n.status ?? n.error)).toEqual([404, 500, 'net::ERR_UNSAFE_PORT'])
    expect(c.consoleSince('s1').filter(e => e.level === 'error').length).toBe(3)
    c.markSnapshot('s1')
    advance(10)
    expect(c.consoleSince('s1', { sinceLastSnapshot: true })).toEqual([])
    g.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: later' } } })
    expect(c.consoleSince('s1', { sinceLastSnapshot: true }).map(e => e.text)).toEqual(['Uncaught: Error: later'])
  })
})

describe('deadlines never poison other work (T3 #12273)', () => {
  it('a hung command times out, resets only this pocket, and the next call works', async () => {
    const { c } = controller()
    const hung = fakeGuest({ hang: 'Accessibility.getFullAXTree' })
    const other = fakeGuest()
    c.register('p1', 's1', hung.guest); c.register('p2', 's2', other.guest)
    const out = await c.run('s1', 'snapshot', ctx => readProbe(ctx), { timeoutMs: 30 })
    expect(out).toMatchObject({ ok: false, code: 'timeout' })
    expect(hung.dbg.detach).toHaveBeenCalled()
    expect(other.dbg.detach).not.toHaveBeenCalled()
    expect(await c.run('s1', 'status', async () => 'fine')).toEqual({ ok: true, value: 'fine' })
    expect(await c.run('s2', 'status', async () => 'fine')).toEqual({ ok: true, value: 'fine' })
  })
})

describe('human takeover', () => {
  it('a human click mid-action aborts it; mutations then pause while reads keep working', async () => {
    const { c, driving } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const out = await c.run('s1', 'click', async ctx => { c.noteHumanInput('p1', { x: 5, y: 5 }); ctx.checkEpoch(); return 1 }, { mutating: true })
    expect(out).toMatchObject({ ok: false, code: 'user_took_control' })
    expect(driving).toContainEqual({ pocketId: 'p1', state: 'user-paused' })
    expect(await c.run('s1', 'type', async () => 1, { mutating: true })).toMatchObject({ ok: false, code: 'paused_by_user' })
    expect(await c.run('s1', 'snapshot', async () => 'read')).toEqual({ ok: true, value: 'read' })
    c.resume('p1')
    expect(await c.run('s1', 'type', async () => 1, { mutating: true })).toEqual({ ok: true, value: 1 })
  })

  it('the echo of the agent\'s own click or keystrokes is not a takeover', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const out = await c.run('s1', 'click', async ctx => {
      ctx.expectPointer(100, 40); c.noteHumanInput('p1', { x: 100.5, y: 40 })
      ctx.expectKeys(); c.noteHumanInput('p1')
      ctx.checkEpoch()
      return 'ok'
    }, { mutating: true })
    expect(out).toEqual({ ok: true, value: 'ok' })
  })

  it('hands control back after a minute without human input (D7)', async () => {
    vi.useFakeTimers()
    const { c, driving } = controller()
    c.register('p1', 's1', fakeGuest().guest)
    c.takeOver('p1')
    expect(await c.run('s1', 'x', async () => 1, { mutating: true })).toMatchObject({ code: 'paused_by_user' })
    vi.advanceTimersByTime(TAKEOVER_IDLE_RESUME_MS + 1)
    expect(driving.at(-1)).toEqual({ pocketId: 'p1', state: null })
  })

  it('refuses mutations while DevTools is open on the pocket', async () => {
    const { c } = controller()
    const g = fakeGuest()
    g.openDevTools()
    c.register('p1', 's1', g.guest)
    expect(await c.run('s1', 'click', async () => 1, { mutating: true })).toMatchObject({ ok: false, code: 'devtools_open' })
  })
})

describe('lifecycle', () => {
  it('unregister detaches the debugger before forgetting the guest (electron#53819)', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    await c.run('s1', 'attach', async () => 1)
    await c.unregister('p1')
    expect(g.dbg.detach).toHaveBeenCalled()
    expect(await c.run('s1', 'x', async () => 1)).toMatchObject({ code: 'no_pocket' })
  })

  it('browser_open on a session without a pocket asks the renderer and resolves when the guest registers', async () => {
    const { c, requestOpen } = controller()
    const pending = c.openPocketFor('s1', 'http://localhost:5173/', 2000)
    expect(requestOpen).toHaveBeenCalledWith('s1', 'http://localhost:5173/')
    c.register('p1', 's1', fakeGuest().guest)
    expect(await pending).toBe('opened')
  })

  it('announces driving around a mutating action, and not around reads', async () => {
    const { c, driving } = controller()
    c.register('p1', 's1', fakeGuest().guest)
    await c.run('s1', 'snapshot', async () => 1)
    expect(driving).toEqual([])
    await c.run('s1', 'click', async () => 1, { mutating: true, describe: 'clicked "Sign in"' })
    expect(driving).toEqual([{ pocketId: 'p1', state: 'agent', action: 'clicked "Sign in"' }, { pocketId: 'p1', state: null }])
  })
})

describe('review round fixes (review A)', () => {
  it('#2 an action that timed out while queued never touches the page afterwards', async () => {
    const { c, driving } = controller()
    const g = fakeGuest({ hang: 'Accessibility.getFullAXTree' })
    c.register('p1', 's1', g.guest)
    // A hung read holds the queue; the click behind it times out first.
    const slow = c.run('s1', 'snapshot', ctx => readProbe(ctx), { timeoutMs: 80 })
    const click = c.run('s1', 'click', async ctx => { ctx.checkEpoch(); await ctx.cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }) }, { mutating: true, timeoutMs: 20 })
    expect(await click).toMatchObject({ ok: false, code: 'timeout' })
    await slow
    await new Promise(r => setTimeout(r, 50))
    expect(g.sent.some(s => s.method === 'Input.dispatchMouseEvent')).toBe(false)
    // …and it never announces itself as driving: it never started.
    expect(driving.filter(e => (e as { state: unknown }).state === 'agent')).toEqual([])
  })

  it('#3 browser_open on an existing pocket never asks the renderer to navigate', async () => {
    const { c, requestOpen } = controller()
    c.register('p1', 's1', fakeGuest().guest)
    expect(await c.openPocketFor('s1', 'http://localhost:5173/')).toBe('already')
    expect(requestOpen).not.toHaveBeenCalled()
  })

  it('#3 browser_open is refused while the feature is off', async () => {
    const { c, requestOpen } = controller()
    c.setFlags({ enabled: false, allowEvaluate: false })
    expect(await c.openPocketFor('s1', undefined, 10)).toBe('disabled')
    expect(requestOpen).not.toHaveBeenCalled()
  })

  it('#4 the user\'s click while picking is not "taking control"', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const picking = c.pick('p1')
    // Wait for the overlay to arm (the picker module is imported lazily, so a
    // fixed sleep raced it under load), then the user clicks to pick.
    await vi.waitFor(() => expect(g.sent.some(s => s.method === 'Overlay.setInspectMode' && s.params?.mode === 'searchForNode')).toBe(true))
    c.noteHumanInput('p1', { x: 3, y: 3 })
    c.cancelPick('p1')
    await picking
    expect(await c.run('s1', 'click', async () => 1, { mutating: true })).toEqual({ ok: true, value: 1 })
  })

  it('#5 agentTyping is true only while the agent\'s own keys are in flight', async () => {
    const { c, advance } = controller()
    c.register('p1', 's1', fakeGuest().guest)
    expect(c.agentTyping('p1')).toBe(false)
    await c.run('s1', 'press', async ctx => { ctx.expectKeys(); expect(c.agentTyping('p1')).toBe(true) }, { mutating: true })
    advance(1000)
    expect(c.agentTyping('p1')).toBe(false)
  })

  it('#7 the echo of the agent\'s click is ignored even when reported in other coordinates', async () => {
    const { c } = controller()
    c.register('p1', 's1', fakeGuest().guest)
    const out = await c.run('s1', 'click', async ctx => { ctx.expectPointer(100, 40); c.noteHumanInput('p1', { x: 150, y: 60 }); ctx.checkEpoch(); return 'ok' }, { mutating: true })
    expect(out).toEqual({ ok: true, value: 'ok' })
  })

  it('#6 the colour scheme is re-applied after a timeout reset re-attaches the debugger', async () => {
    const { c } = controller()
    const g = fakeGuest({ hang: 'Accessibility.getFullAXTree' })
    c.register('p1', 's1', g.guest)
    await c.applyEmulation('p1', { colorScheme: 'dark' })
    await c.run('s1', 'snapshot', ctx => readProbe(ctx), { timeoutMs: 20 })
    g.sent.length = 0
    await c.run('s1', 'status', async () => 1)
    expect(g.sent).toContainEqual({ method: 'Emulation.setEmulatedMedia', params: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] } })
  })

  it('caps any requested deadline at 15 s', async () => {
    vi.useFakeTimers()
    const { c } = controller()
    c.register('p1', 's1', fakeGuest({ hang: 'Accessibility.getFullAXTree' }).guest)
    const out = c.run('s1', 'snapshot', ctx => readProbe(ctx), { timeoutMs: 600_000 })
    await vi.advanceTimersByTimeAsync(15_001)
    expect(await out).toMatchObject({ ok: false, code: 'timeout' })
  })

  it('a destroyed guest is not the session\'s pocket any more', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    ;(g.guest as { isDestroyed: () => boolean }).isDestroyed = () => true
    expect(await c.run('s1', 'x', async () => 1)).toMatchObject({ code: 'no_pocket' })
  })

  it('#9 an abandoned browser_open leaves no waiter behind, and turning the feature off detaches', async () => {
    const { c } = controller()
    expect(await c.openPocketFor('s1', undefined, 10)).toBe('timeout')
    expect((c as unknown as { registrationWaiters: Map<string, unknown> }).registrationWaiters.size).toBe(0)
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    await c.run('s1', 'x', async () => 1)
    c.setFlags({ enabled: false, allowEvaluate: false })
    expect(g.dbg.detach).toHaveBeenCalled()
  })

  it('#9 an id remap carries the "since last snapshot" cursor, so old errors are not repeated', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 'old', g.guest)
    await c.run('old', 'x', async () => 1)
    for (const e of errorEvents) g.emit(e.method, e.params)
    c.markSnapshot('old')
    c.register('p1', 'new', g.guest)
    expect(c.consoleSince('new', { sinceLastSnapshot: true })).toEqual([])
  })
})

/** An action that holds the pocket's queue until released. */
function holdQueue(c: BrowserPocketController, sessionId: string, timeoutMs = 2_000) {
  let release!: () => void
  const held = new Promise<void>(r => { release = r })
  const done = c.run(sessionId, 'hold', async () => { await held; return 'held' }, { timeoutMs })
  return { release, done }
}
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms))

describe('review round 2 (review A)', () => {
  it('#2 a mutation queued before the feature is turned off never runs', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const hold = holdQueue(c, 's1')
    const click = c.run('s1', 'click', async ctx => { await ctx.cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed' }) }, { mutating: true })
    await tick()
    c.setFlags({ enabled: false, allowEvaluate: false })
    hold.release()
    expect(await click).toMatchObject({ ok: false, code: 'disabled' })
    await tick()
    expect(g.sent.some(s => s.method === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('#2 a mutation queued before unregister never runs', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const hold = holdQueue(c, 's1')
    const click = c.run('s1', 'click', async ctx => { await ctx.cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed' }) }, { mutating: true })
    await tick()
    await c.unregister('p1')
    hold.release()
    expect(await click).toMatchObject({ ok: false, code: 'no_pocket' })
    await tick()
    expect(g.sent.some(s => s.method === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('#2 work queued by the old session never runs after a remap', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 'old', g.guest)
    const hold = holdQueue(c, 'old')
    const click = c.run('old', 'click', async ctx => { await ctx.cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed' }) }, { mutating: true })
    await tick()
    c.register('p1', 'new', g.guest)
    hold.release()
    expect(await click).toMatchObject({ ok: false, code: 'no_pocket' })
    expect(g.sent.some(s => s.method === 'Input.dispatchMouseEvent')).toBe(false)
  })

  it('#4 cancelling a pick that is still queued never arms the overlay', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const hold = holdQueue(c, 's1')
    const picking = c.pick('p1')
    await tick()
    c.cancelPick('p1')
    hold.release()
    expect(await picking).toEqual({ kind: 'cancelled' })
    expect(g.sent.some(s => s.method === 'Overlay.setInspectMode' && s.params?.mode === 'searchForNode')).toBe(false)
  })

  // #1431 review a: a pick ended by the lifecycle (the feature switched off
  // while it waited in the queue) is not the user's cancel.
  it('says a queued pick ended by the feature switching off as unavailable', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const hold = holdQueue(c, 's1')
    const picking = c.pick('p1')
    await tick()
    c.setFlags({ enabled: false, allowEvaluate: false })
    hold.release()
    expect(await picking).toEqual({ kind: 'failed', reason: 'unavailable' })
  })

  // #1431 review a: with DevTools opened after a pick armed, a second pick
  // settles the first instead of leaving it to its 60 s wait.
  it('settles an armed pick when a second pick finds DevTools open', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const first = c.pick('p1')
    await vi.waitFor(() => expect(g.sent.some(s => s.method === 'Overlay.setInspectMode' && s.params?.mode === 'searchForNode')).toBe(true))
    g.openDevTools()
    expect(await c.pick('p1')).toEqual({ kind: 'failed', reason: 'devtools-open' })
    expect(await first).toEqual({ kind: 'failed', reason: 'devtools-open' })
  })

  // #1431 review a: a pick cancelled while still queued left its abort handle
  // behind, so later cancels and resets called a stale closure.
  it('clears the abort handle of a pick cancelled in the queue', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const hold = holdQueue(c, 's1')
    const picking = c.pick('p1')
    await tick()
    c.cancelPick('p1')
    hold.release()
    expect(await picking).toEqual({ kind: 'cancelled' })
    expect((c as unknown as { pockets: Map<string, { pickAbort: unknown }> }).pockets.get('p1')!.pickAbort).toBeNull()
  })

  // A pick that runs to completion, driven through the real picker against the
  // fake debugger: the user clicks a node, and the CDP calls that resolve it
  // answer as Chromium does. `gate` holds one method until released.
  function completingGuest(gate?: { method: string; promise: Promise<void> }) {
    const g = fakeGuest()
    const answer = (method: string): unknown => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame-1' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'node-1' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: { path: [{ tag: 'button', id: 'save', nth: 1 }], role: 'button', name: 'Save' } } }
      return {}
    }
    g.dbg.sendCommand.mockImplementation(async (method: string, params?: any) => {
      g.sent.push({ method, params })
      if (gate && method === gate.method) await gate.promise
      return answer(method)
    })
    return g
  }
  const armed = (g: ReturnType<typeof fakeGuest>) =>
    vi.waitFor(() => expect(g.sent.some(s => s.method === 'Overlay.setInspectMode' && s.params?.mode === 'searchForNode')).toBe(true))

  // #1431 review c: no test drove a pick to completion.
  it('answers picked with the element for a completed pick', async () => {
    const { c } = controller()
    const g = completingGuest()
    c.register('p1', 's1', g.guest)
    const picking = c.pick('p1')
    await armed(g)
    g.emit('Overlay.inspectNodeRequested', { backendNodeId: 42 })
    expect(await picking).toMatchObject({ kind: 'picked', result: { selector: '#save', role: 'button', name: 'Save' } })
  })

  // #1431 review b: after the node is chosen the picker resolves it through
  // more CDP calls with no abort hook. An abort landing then must still win.
  it.each([
    ['a cancel', (c: BrowserPocketController) => c.cancelPick('p1'), { kind: 'cancelled' }],
    ['the feature switching off', (c: BrowserPocketController) => c.setFlags({ enabled: false, allowEvaluate: false }), { kind: 'failed', reason: 'unavailable' }],
  ] as const)('lets %s during node resolution win over the picked element', async (_name, abort, expected) => {
    const { c } = controller()
    let release!: () => void
    const g = completingGuest({ method: 'Page.getFrameTree', promise: new Promise<void>(resolve => { release = resolve }) })
    c.register('p1', 's1', g.guest)
    const picking = c.pick('p1')
    await armed(g)
    g.emit('Overlay.inspectNodeRequested', { backendNodeId: 42 })
    await vi.waitFor(() => expect(g.sent.some(s => s.method === 'Page.getFrameTree')).toBe(true))
    abort(c)
    release()
    expect(await picking).toEqual(expected)
  })

  // #1431 review c: a guest destroyed mid-pick used to leave the pick armed
  // for its 60 s, with no way to cancel it, then a silent cancel.
  it('settles an armed pick as unavailable when its guest is destroyed', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const picking = c.pick('p1')
    await armed(g)
    const destroyed = g.guest.once.mock.calls.find(call => call[0] === 'destroyed')![1] as () => void
    destroyed()
    expect(await picking).toEqual({ kind: 'failed', reason: 'unavailable' })
  })

  // #1431 review c: the DevTools re-check when a pick is REJECTED, the first
  // abort's reason winning over a later reasonless one, and the main-side warn.
  it('says DevTools for a pick rejected while DevTools opened, and warns the raw error', async () => {
    const { c } = controller()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const d = fakeGuest()
      c.register('pd', 'sd', d.guest)
      const hold = holdQueue(c, 'sd')
      const picking = c.pick('pd')
      await tick()
      d.openDevTools()
      // With DevTools holding the page, the pick's first CDP command fails.
      d.dbg.sendCommand.mockImplementation(async (method: string) => {
        if (method === 'Overlay.enable') throw new Error('Overlay is not available while DevTools is open')
        return {}
      })
      hold.release()
      expect(await picking).toEqual({ kind: 'failed', reason: 'devtools-open' })
      expect(warn).toHaveBeenCalledWith('[browser-pocket] pick failed:', expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps the first abort reason over a later cancel', async () => {
    const { c } = controller()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const e = fakeGuest()
      c.register('pe', 'se', e.guest)
      const holdE = holdQueue(c, 'se')
      const second = c.pick('pe')
      await tick()
      c.setFlags({ enabled: false, allowEvaluate: false })
      c.cancelPick('pe')
      holdE.release()
      expect(await second).toEqual({ kind: 'failed', reason: 'unavailable' })
    } finally {
      warn.mockRestore()
    }
  })

  // #1305: every pick failure used to answer null, which the renderer reads
  // as the user's own cancel. Each now says what happened.
  it('answers why a pick failed instead of a cancel-shaped null', async () => {
    const { c } = controller()
    // No pocket.
    expect(await c.pick('nope')).toEqual({ kind: 'failed', reason: 'unavailable' })
    // DevTools open: the debugger cannot attach, and the overlay never arms.
    const d = fakeGuest()
    c.register('pd', 'sd', d.guest)
    d.openDevTools()
    expect(await c.pick('pd')).toEqual({ kind: 'failed', reason: 'devtools-open' })
    expect(d.sent.some(s => s.method === 'Overlay.setInspectMode')).toBe(false)
    // Any other CDP failure.
    const e = fakeGuest()
    c.register('pe', 'se', e.guest)
    e.dbg.attach.mockImplementation(() => { throw new Error('Debugger attach failed') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await c.pick('pe')).toEqual({ kind: 'failed', reason: 'error' })
    warn.mockRestore()
    // The feature switched off.
    c.setFlags({ enabled: false, allowEvaluate: false })
    expect(await c.pick('pe')).toEqual({ kind: 'failed', reason: 'unavailable' })
  })

  it('#4 a cancel that lands while the overlay is being enabled never arms it', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const send = g.dbg.sendCommand.getMockImplementation()!
    g.dbg.sendCommand.mockImplementation(async (method: string, params?: any) => {
      if (method === 'Overlay.enable') c.cancelPick('p1')
      return send(method, params)
    })
    expect(await c.pick('p1')).toEqual({ kind: 'cancelled' })
    expect(g.sent.some(s => s.method === 'Overlay.setInspectMode' && s.params?.mode === 'searchForNode')).toBe(false)
  })

  it('#5 an action that times out while QUEUED does not reset the pocket under the running one', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const hold = holdQueue(c, 's1')
    await tick()
    const queued = c.run('s1', 'snapshot', ctx => readProbe(ctx), { timeoutMs: 20 })
    expect(await queued).toMatchObject({ ok: false, code: 'timeout' })
    // The running action keeps its debugger and completes normally.
    expect(g.dbg.detach).not.toHaveBeenCalled()
    hold.release()
    expect(await hold.done).toEqual({ ok: true, value: 'held' })
  })

  it('#5 a running action\'s deadline answers everything queued behind it at once', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const stalled = holdQueue(c, 's1', 40)
    const behind = c.run('s1', 'snapshot', ctx => readProbe(ctx), { timeoutMs: 5_000 })
    expect(await stalled.done).toMatchObject({ ok: false, code: 'timeout' })
    expect(await behind).toMatchObject({ ok: false, code: 'timeout' })
    expect(g.dbg.detach).toHaveBeenCalled()
    // The pocket works again right away.
    expect(await c.run('s1', 'x', async () => 1)).toEqual({ ok: true, value: 1 })
  })

  it('#6 paint and driving signals of queued actions never overlap', async () => {
    const events: string[] = []
    const { c } = controller({
      emitPaint: (_id, on) => events.push(on ? 'paint' : 'unpaint'),
      emitDriving: e => events.push(e.state === 'agent' ? 'drive' : e.state === null ? 'undrive' : String(e.state)),
    })
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    await Promise.all([
      c.run('s1', 'a', async () => { await tick() }, { mutating: true }),
      c.run('s1', 'b', async () => { await tick() }, { mutating: true }),
    ])
    expect(events).toEqual(['paint', 'drive', 'undrive', 'unpaint', 'paint', 'drive', 'undrive', 'unpaint'])
  })
})

it('revoking evaluation while it is queued prevents any expression from running', async () => {
  const { c } = controller()
  c.setFlags({ enabled: true, allowEvaluate: true })
  c.register('p1', 's1', fakeGuest().guest)
  let release!: () => void
  const blocker = c.run('s1', 'snapshot', () => new Promise<void>(resolve => { release = resolve }))
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  const evaluate = vi.fn(async () => 42)
  const pending = c.run('s1', 'evaluate', evaluate, { mutating: true })
  c.setFlags({ enabled: true, allowEvaluate: false })
  release()
  await blocker
  expect(await pending).toMatchObject({ ok: false, code: 'disabled' })
  expect(evaluate).not.toHaveBeenCalled()
})

it('revoking evaluation during isolated-world setup prevents expression dispatch', async () => {
  const { c } = controller()
  c.setFlags({ enabled: true, allowEvaluate: true })
  const g = fakeGuest()
  c.register('p1', 's1', g.guest)
  g.dbg.sendCommand.mockImplementation(async (method: string) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } }
    if (method === 'Page.createIsolatedWorld') {
      c.setFlags({ enabled: true, allowEvaluate: false })
      return { executionContextId: 42 }
    }
    return {}
  })
  expect(await c.run('s1', 'evaluate', ctx => evaluateIsolated(ctx, 'document.body.remove()'), { mutating: true })).toMatchObject({ ok: false, code: 'disabled' })
  expect(g.dbg.sendCommand.mock.calls.some(([method]) => method === 'Runtime.evaluate')).toBe(false)
})

it('a deadline unsticks a non-cooperative action after takeover', async () => {
  vi.useFakeTimers()
  const { c } = controller()
  const g = fakeGuest()
  c.register('p1', 's1', g.guest)
  let started = false
  const pending = c.run('s1', 'press', async () => { started = true; await new Promise(() => {}) }, { mutating: true, timeoutMs: 20 })
  await Promise.resolve()
  expect(started).toBe(true)
  c.takeOver('p1')
  await vi.advanceTimersByTimeAsync(25)
  expect(await pending).toMatchObject({ ok: false, code: 'user_took_control' })
  c.resume('p1')
  expect(await c.run('s1', 'snapshot', async () => 'working', { timeoutMs: 50 })).toMatchObject({ ok: true, value: 'working' })
  expect(g.dbg.detach).toHaveBeenCalled()
})
