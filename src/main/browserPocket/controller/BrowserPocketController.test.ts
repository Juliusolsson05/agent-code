import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrowserPocketController, TAKEOVER_IDLE_RESUME_MS, type ControllerDeps, type GuestLike, type ImageLike } from './BrowserPocketController'
import { clickNode, snapshot, typeInto } from './actions'

// The fake debugger answers with RECORDED Chrome responses (Stage-1
// fixtures): the real accessibility tree and real content quads of the form
// page, and it replays the real event stream of the broken page. Only the
// wiring (which command returns which recording) is written here.
const FIX = join(__dirname, '..', '__fixtures__')
const axForm = JSON.parse(readFileSync(join(FIX, 'axtree.form.json'), 'utf8'))
const geometry = new Map((JSON.parse(readFileSync(join(FIX, 'dom-geometry.form.json'), 'utf8')).geometry as Array<{ backendNodeId: number; quads: unknown; box: { model: { content: number[] } } }>).map(g => [g.backendNodeId, g]))
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
      if (method === 'DOM.getContentQuads') return geometry.get(params.backendNodeId)?.quads ?? { quads: [] }
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
    await c.run('sa', 'snapshot', ctx => snapshot(ctx))
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
  it('snapshot → click by ref lands a trusted click inside the recorded button box', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const snap = await c.run('s1', 'snapshot', ctx => snapshot(ctx))
    expect(snap.ok).toBe(true)
    const ref = /- button "Sign in" \[ref=(e\d+)\]/.exec((snap as { value: { text: string } }).value.text)![1]!
    const backendId = (snap as { value: { refs: Map<string, number> } }).value.refs.get(ref)!
    const out = await c.run('s1', 'click', ctx => clickNode(ctx, backendId), { mutating: true })
    expect(out).toEqual({ ok: true, value: undefined })
    const press = g.sent.find(s => s.method === 'Input.dispatchMouseEvent' && s.params.type === 'mousePressed')!.params
    const box = geometry.get(backendId)!.box.model.content
    expect(press.x).toBeGreaterThan(Math.min(box[0]!, box[4]!)); expect(press.x).toBeLessThan(Math.max(box[0]!, box[4]!))
    expect(press.y).toBeGreaterThan(Math.min(box[1]!, box[5]!)); expect(press.y).toBeLessThan(Math.max(box[1]!, box[5]!))
  })

  it('typing uses focus emulation on the guest, never a host focus call', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    await c.run('s1', 'type', ctx => typeInto(ctx, 22, 'me@example.com', { clear: true }), { mutating: true })
    const methods = g.sent.map(s => s.method)
    expect(methods).toContain('Emulation.setFocusEmulationEnabled')
    expect(methods.indexOf('Emulation.setFocusEmulationEnabled')).toBeLessThan(methods.indexOf('Input.insertText'))
  })

  it('an element with no layout box fails with an explanation instead of clicking 0,0', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const out = await c.run('s1', 'click', ctx => clickNode(ctx, 999_999), { mutating: true })
    expect(out).toMatchObject({ ok: false, code: 'failed' })
    expect(g.sent.some(s => s.method === 'Input.dispatchMouseEvent')).toBe(false)
  })

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
    const out = await c.run('s1', 'snapshot', ctx => snapshot(ctx), { timeoutMs: 30 })
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
    const slow = c.run('s1', 'snapshot', ctx => snapshot(ctx), { timeoutMs: 80 })
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
    await c.run('s1', 'snapshot', ctx => snapshot(ctx), { timeoutMs: 20 })
    g.sent.length = 0
    await c.run('s1', 'status', async () => 1)
    expect(g.sent).toContainEqual({ method: 'Emulation.setEmulatedMedia', params: { features: [{ name: 'prefers-color-scheme', value: 'dark' }] } })
  })

  it('caps any requested deadline at 15 s', async () => {
    vi.useFakeTimers()
    const { c } = controller()
    c.register('p1', 's1', fakeGuest({ hang: 'Accessibility.getFullAXTree' }).guest)
    const out = c.run('s1', 'snapshot', ctx => snapshot(ctx), { timeoutMs: 600_000 })
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

  it('#3 a takeover after select-all stops the clear and the typing', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const send = g.dbg.sendCommand.getMockImplementation()!
    g.dbg.sendCommand.mockImplementation(async (method: string, params?: any) => {
      const out = await send(method, params)
      // The user clicks the page right after the agent's select-all.
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp' && params.key === 'a') c.takeOver('p1')
      return out
    })
    const out = await c.run('s1', 'type', ctx => typeInto(ctx, 22, 'agent text', { clear: true }), { mutating: true })
    expect(out).toMatchObject({ ok: false, code: 'user_took_control' })
    const keys = g.sent.filter(s => s.method === 'Input.dispatchKeyEvent').map(s => `${s.params.type}:${s.params.key}`)
    // The select-all key that went down was released; nothing after it ran.
    expect(keys).toEqual(['keyDown:a', 'keyUp:a'])
    expect(g.sent.some(s => s.method === 'Input.insertText')).toBe(false)
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
    expect(await picking).toBeNull()
    expect(g.sent.some(s => s.method === 'Overlay.setInspectMode' && s.params?.mode === 'searchForNode')).toBe(false)
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
    expect(await c.pick('p1')).toBeNull()
    expect(g.sent.some(s => s.method === 'Overlay.setInspectMode' && s.params?.mode === 'searchForNode')).toBe(false)
  })

  it('#5 an action that times out while QUEUED does not reset the pocket under the running one', async () => {
    const { c } = controller()
    const g = fakeGuest()
    c.register('p1', 's1', g.guest)
    const hold = holdQueue(c, 's1')
    await tick()
    const queued = c.run('s1', 'snapshot', ctx => snapshot(ctx), { timeoutMs: 20 })
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
    const behind = c.run('s1', 'snapshot', ctx => snapshot(ctx), { timeoutMs: 5_000 })
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
