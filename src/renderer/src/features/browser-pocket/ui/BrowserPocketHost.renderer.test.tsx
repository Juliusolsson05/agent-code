import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GlobalToastProvider } from '@renderer/ui/GlobalToast'
import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { WorkspaceState } from '@renderer/workspace/types'

import { usePlacementStore } from '../placement/placementStore'
import { usePocketLiveStore } from '../state/pocketLiveStore'
import { useRecoveryStore } from '../recovery/recoveryStore'
import { BrowserPocketHost, wrapperStyle } from './BrowserPocketHost'

// Review B #1–#3: the guest lifecycle had no test, and that is where the
// blocking bug was. The host is rendered for real; only the Electron edge is
// faked (a <webview> element with the guest methods, and a recording
// window.api). Every guest removal must be preceded by main unregistering it.

const log: string[] = []
let original = useAppStore.getState()

function installApi(opts: { registerDelayMs?: number } = {}) {
  const calls = {
    deliver: vi.fn<typeof window.api.deliverPrompt>().mockResolvedValue({ ok: true, acceptance: { kind: 'queue', acceptedAt: 1 } }),
    register: vi.fn(async (p: { pocketId: string; sessionId: string }) => {
      log.push(`register:${p.sessionId}`)
      if (opts.registerDelayMs) await new Promise(r => setTimeout(r, opts.registerDelayMs))
      return { ok: true }
    }),
    // Resolves a tick LATER and records how many guests still exist at that
    // moment: the element may only leave the DOM after main has answered, so
    // a fire-and-forget unregister would log guests=0 here.
    unregister: vi.fn(async () => {
      await new Promise(r => setTimeout(r, 5))
      log.push(`unregister(guests=${document.querySelectorAll('webview').length})`)
    }),
  }
  const noop = () => () => {}
  window.api = new Proxy({
    deliverPrompt: calls.deliver,
    pocketPartition: async () => 'persist:ac-pocket-p1',
    registerPocketGuest: calls.register,
    unregisterPocketGuest: calls.unregister,
    applyPocketEmulation: async () => {},
    pocketThumbnail: async () => null,
    setPocketFlags: async () => {},
    setPocketPortWatch: async () => {},
    clearPocketStorage: async () => {},
  } as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : /^on[A-Z]/.test(key) ? noop : async () => {}),
  }) as unknown as typeof window.api
  return calls
}

function workspace(sessionId: string, pocket: Record<string, unknown> | null) {
  const updates: Array<(s: WorkspaceState) => WorkspaceState> = []
  const ws = {
    state: { sessions: { [sessionId]: { cwd: '/w', kind: 'claude', projectId: 'proj', ...(pocket ? { browserPocket: pocket } : {}) } }, stage: { lanes: [] } },
    runtimes: {},
    updateBrowserPocket: (t: (s: WorkspaceState) => WorkspaceState) => { updates.push(t) },
    setTiledFocusedLane: vi.fn(),
    ensureSessionLive: vi.fn(async () => ({ sessionId })),
    setSpotlightTarget: vi.fn(),
  } as unknown as Workspace
  // Prompt admission reads the authoritative store even before React catches
  // up after a wake. Keep that edge real instead of trusting a stale ws prop.
  useAppStore.setState({ workspaceState: ws.state, workspaceRuntimes: ws.runtimes })
  return { ws, updates }
}

function showSlot(visible = true, lane = { index: 0, focused: true }) {
  act(() => usePlacementStore.getState().report('p1', { slotKey: `lane:${lane.index}`, surface: 'lane', laneIndex: lane.index, focused: lane.focused, visible, dimmed: !lane.focused, rect: { x: 0, y: 0, width: 800, height: 600 }, clip: null }))
}

function guest(url = 'http://localhost:3000/'): HTMLElement & { url: string } {
  const el = document.querySelector('webview') as HTMLElement & Record<string, unknown>
  Object.assign(el, {
    url,
    getWebContentsId: () => 7, getURL() { return this.url as string }, canGoBack: () => false, canGoForward: () => false,
    loadURL: vi.fn(async () => {}), reload: () => {}, reloadIgnoringCache: () => {}, goBack: () => {}, goForward: () => {}, openDevTools: () => {},
  })
  return el as unknown as HTMLElement & { url: string }
}

const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 10)) }) }
const renderHost = (ws: Workspace) => render(<GlobalToastProvider><BrowserPocketHost workspace={ws} /></GlobalToastProvider>)
const POCKET = { pocketId: 'p1', url: 'http://localhost:3000/', view: 'open', profile: 'lane' }

beforeEach(() => {
  original = useAppStore.getState()
  useAppStore.setState({ settings: { ...original.settings, browserPocketEnabled: true } })
  log.length = 0
  usePlacementStore.setState({ slots: {}, paintLeases: {}, lastSize: {}, lastVisibleAt: {} })
  usePocketLiveStore.setState({ live: {} })
  useRecoveryStore.setState({ requests: {} })
})
afterEach(() => { cleanup(); useAppStore.setState(original, true) })

function fail(el: HTMLElement, url = 'http://localhost:3000/', code = -102) {
  act(() => { el.dispatchEvent(Object.assign(new Event('did-fail-load'), { isMainFrame: true, validatedURL: url, errorCode: code, errorDescription: 'Connection failed' })) })
}

describe('local server recovery UI', () => {
  it.each([['https://example.com/', -102], ['http://localhost:3000/', -200], ['http://localhost:3000/', -105]])('keeps ordinary reload without restart for %s (%i)', async (url, code) => {
    installApi()
    renderHost(workspace('s1', POCKET).ws)
    showSlot()
    await flush()
    fail(guest(), url, code)
    expect(screen.queryByRole('button', { name: 'Try to restart' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeTruthy()
  })

  it('sends once, survives guest remount/hidden overlay, and reloads the failed destination without sending again', async () => {
    const calls = installApi()
    renderHost(workspace('s1', POCKET).ws)
    showSlot()
    await flush()
    const el = guest()
    act(() => { el.dispatchEvent(new Event('dom-ready')) })
    await flush()
    const failedUrl = 'http://localhost:5173/dashboard?filter=mine'
    fail(el, failedUrl)
    fireEvent.click(screen.getByRole('button', { name: 'Try to restart' }))
    await flush()
    expect(calls.deliver).toHaveBeenCalledTimes(1)
    expect(calls.deliver.mock.calls[0]?.[0]).toBe('s1')
    expect(screen.getByRole('status').textContent).toBe('Queued for agent')

    fireEvent.click(screen.getByRole('button', { name: 'Reload page' }))
    expect((el as unknown as { loadURL: ReturnType<typeof vi.fn> }).loadURL).toHaveBeenCalledWith(failedUrl)
    expect(log).not.toContain('unregister(guests=1)')
    fail(el, failedUrl)
    expect(screen.queryByRole('button', { name: 'Try to restart' })).toBeNull()
    act(() => { el.dispatchEvent(Object.assign(new Event('did-navigate'), { isMainFrame: true, httpResponseCode: -1 })) })
    expect(screen.getByRole('status').textContent).toBe('Queued for agent')
    showSlot(false)
    await flush()
    showSlot()
    await flush()
    expect(screen.getByRole('status').textContent).toBe('Queued for agent')
    act(() => usePocketLiveStore.getState().patch('p1', p => ({ generation: p.generation + 1 })))
    await flush()
    expect(log).toContain('unregister(guests=1)')
    expect(screen.getByRole('status').textContent).toBe('Queued for agent')
    expect(calls.deliver).toHaveBeenCalledTimes(1)
  })

  it('clears receipts on a successful navigation and ignores events from the retired guest', async () => {
    installApi()
    const view = renderHost(workspace('s1', POCKET).ws)
    showSlot()
    await flush()
    const el = guest()
    fail(el)
    fireEvent.click(screen.getByRole('button', { name: 'Try to restart' }))
    await flush()
    act(() => { el.dispatchEvent(Object.assign(new Event('did-navigate'), { isMainFrame: true, httpResponseCode: 200 })) })
    expect(useRecoveryStore.getState().requests.p1).toBeUndefined()
    fail(el)
    expect(screen.getByRole('button', { name: 'Try to restart' })).toBeTruthy()
    view.rerender(<GlobalToastProvider><BrowserPocketHost workspace={workspace('s1', null).ws} /></GlobalToastProvider>)
    await flush()
    fail(el)
    expect(usePocketLiveStore.getState().live.p1).toBeUndefined()
  })

  it('does not send to a successor when the session changes during wake', async () => {
    const calls = installApi()
    let finishWake!: () => void
    const { ws } = workspace('old', POCKET)
    vi.mocked(ws.ensureSessionLive).mockImplementation(() => new Promise(resolve => { finishWake = () => resolve({ sessionId: 'old' }) }))
    const view = renderHost(ws)
    showSlot()
    await flush()
    fail(guest())
    fireEvent.click(screen.getByRole('button', { name: 'Try to restart' }))
    view.rerender(<GlobalToastProvider><BrowserPocketHost workspace={workspace('new', POCKET).ws} /></GlobalToastProvider>)
    await act(async () => { finishWake() })
    expect(calls.deliver).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Try to restart' })).toBeTruthy()
  })

  it('shows uncertainty instead of a resend and explicitly reveals this pocket owner', async () => {
    const calls = installApi()
    calls.deliver.mockRejectedValue(new Error('IPC lost after write'))
    const { ws, updates } = workspace('s1', POCKET)
    renderHost(ws)
    showSlot()
    await flush()
    fail(guest())
    fireEvent.click(screen.getByRole('button', { name: 'Try to restart' }))
    await flush()
    expect(screen.getByRole('status').textContent).toContain('Could not confirm delivery')
    expect(screen.queryByRole('button', { name: 'Try to restart' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View agent' }))
    expect(ws.setSpotlightTarget).toHaveBeenCalledWith('s1')
    expect(updates.at(-1)!(ws.state).sessions.s1?.browserPocket?.view).toBe('collapsed')
  })

  it('revokes a pending request when main-frame navigation changes the target', async () => {
    const calls = installApi()
    let finishWake!: () => void
    const { ws } = workspace('s1', POCKET)
    vi.mocked(ws.ensureSessionLive).mockImplementation(() => new Promise(resolve => { finishWake = () => resolve({ sessionId: 's1' }) }))
    renderHost(ws)
    showSlot()
    await flush()
    const el = guest()
    fail(el)
    fireEvent.click(screen.getByRole('button', { name: 'Try to restart' }))
    act(() => { el.dispatchEvent(Object.assign(new Event('did-start-navigation'), { isMainFrame: true, url: 'https://example.com/' })) })
    await act(async () => { finishWake() })
    expect(calls.deliver).not.toHaveBeenCalled()
  })
})

describe('guest lifecycle', () => {
  it('registers a new guest on dom-ready with the session that owns it', async () => {
    installApi()
    const { ws } = workspace('s1', POCKET)
    renderHost(ws)
    showSlot()
    await flush()
    const el = guest()
    expect(el.getAttribute('src')).toBe('http://localhost:3000/')
    act(() => { el.dispatchEvent(new Event('dom-ready')) })
    await flush()
    expect(log).toEqual(['register:s1'])
  })

  it('sleep unregisters BEFORE the guest leaves the DOM; waking registers the new guest again', async () => {
    installApi()
    const { ws } = workspace('s1', POCKET)
    renderHost(ws)
    showSlot()
    await flush()
    act(() => { guest().dispatchEvent(new Event('dom-ready')) })
    await flush()
    showSlot(false)
    act(() => usePocketLiveStore.getState().patch('p1', { asleep: true }))
    await flush()
    expect(document.querySelectorAll('webview')).toHaveLength(0)
    expect(log).toEqual(['register:s1', 'unregister(guests=1)'])
    showSlot(true)
    await flush()
    await flush()
    act(() => { guest().dispatchEvent(new Event('dom-ready')) })
    await flush()
    expect(log).toEqual(['register:s1', 'unregister(guests=1)', 'register:s1'])
  })

  it('after a SessionId remap, navigations are saved to the NEW session', async () => {
    installApi()
    const first = workspace('old', POCKET)
    const view = renderHost(first.ws)
    showSlot()
    await flush()
    act(() => { guest().dispatchEvent(new Event('dom-ready')) })
    await flush()
    const second = workspace('new', POCKET)
    view.rerender(<GlobalToastProvider><BrowserPocketHost workspace={second.ws} /></GlobalToastProvider>)
    await flush()
    const el = guest('http://localhost:3000/after')
    act(() => { el.dispatchEvent(Object.assign(new Event('did-navigate'), { isMainFrame: true })) })
    const state = second.updates.at(-1)!(second.ws.state as WorkspaceState)
    expect(state.sessions['new' as never]?.browserPocket?.url).toBe('http://localhost:3000/after')
  })

  it('a crash remount unregisters first and restarts at the CURRENT url, not the first one', async () => {
    installApi()
    const first = workspace('s1', POCKET)
    const view = renderHost(first.ws)
    showSlot()
    await flush()
    act(() => { guest().dispatchEvent(new Event('dom-ready')) })
    await flush()
    // The user navigated; SessionMeta now holds the new url.
    const moved = workspace('s1', { ...POCKET, url: 'http://localhost:3000/dashboard' })
    view.rerender(<GlobalToastProvider><BrowserPocketHost workspace={moved.ws} /></GlobalToastProvider>)
    await flush()
    act(() => { guest().dispatchEvent(new Event('render-process-gone')) })
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })
    await flush()
    expect(log).toContain('unregister(guests=1)')
    expect(guest().getAttribute('src')).toBe('http://localhost:3000/dashboard')
  })

  it('a detached pocket keeps its guest mounted until main has unregistered it', async () => {
    installApi()
    const { ws } = workspace('s1', POCKET)
    const view = renderHost(ws)
    showSlot()
    await flush()
    act(() => { guest().dispatchEvent(new Event('dom-ready')) })
    await flush()
    const detached = workspace('s1', null)
    view.rerender(<GlobalToastProvider><BrowserPocketHost workspace={detached.ws} /></GlobalToastProvider>)
    await flush()
    await flush()
    expect(log).toEqual(['register:s1', 'unregister(guests=1)'])
    expect(document.querySelectorAll('webview')).toHaveLength(0)
  })
})

describe('review round 2 (review B)', () => {
  it('#1 an agent opening a collapsed pocket with no slot gets a guest, and it registers', async () => {
    installApi()
    const { ws } = workspace('s1', { pocketId: 'p1', view: 'collapsed', profile: 'lane' })
    renderHost(ws)
    await flush()
    // Collapsed, no url, no slot: nothing to show and nothing is created.
    expect(document.querySelectorAll('webview')).toHaveLength(0)
    act(() => usePocketLiveStore.getState().patch('p1', { agentOpening: true }))
    await flush()
    await flush()
    act(() => { guest().dispatchEvent(new Event('dom-ready')) })
    await flush()
    expect(log).toEqual(['register:s1'])
    expect(usePocketLiveStore.getState().live.p1?.agentOpening).toBe(false)
  })

  it('#2 turning the feature off unregisters every guest BEFORE it leaves the DOM', async () => {
    installApi()
    const { ws } = workspace('s1', POCKET)
    renderHost(ws)
    showSlot()
    await flush()
    act(() => { guest().dispatchEvent(new Event('dom-ready')) })
    await flush()
    act(() => useAppStore.setState({ settings: { ...useAppStore.getState().settings, browserPocketEnabled: false } }))
    await flush()
    await flush()
    expect(log).toEqual(['register:s1', 'unregister(guests=1)'])
    expect(document.querySelectorAll('webview')).toHaveLength(0)
  })

  it('#3 a session closing while a sleep teardown is in flight waits for the SAME unregister', async () => {
    installApi()
    const { ws } = workspace('s1', POCKET)
    const view = renderHost(ws)
    showSlot()
    await flush()
    act(() => { guest().dispatchEvent(new Event('dom-ready')) })
    await flush()
    showSlot(false)
    // Sleep starts a teardown (unregister takes a few ms)…
    act(() => usePocketLiveStore.getState().patch('p1', { asleep: true }))
    // …and the session closes before main answers.
    view.rerender(<GlobalToastProvider><BrowserPocketHost workspace={workspace('s1', null).ws} /></GlobalToastProvider>)
    await flush()
    await flush()
    expect(log).toEqual(['register:s1', 'unregister(guests=1)'])
    expect(document.querySelectorAll('webview')).toHaveLength(0)
  })

  it('#4 a session remap while the first registration is in flight re-registers the new id', async () => {
    installApi({ registerDelayMs: 5 })
    const view = renderHost(workspace('old', POCKET).ws)
    showSlot()
    await flush()
    act(() => { guest().dispatchEvent(new Event('dom-ready')) })
    view.rerender(<GlobalToastProvider><BrowserPocketHost workspace={workspace('new', POCKET).ws} /></GlobalToastProvider>)
    await flush()
    await flush()
    expect(log).toEqual(['register:old', 'register:new'])
  })

  it('#5 focusing another lane\'s page moves lane focus to that lane', async () => {
    installApi()
    const { ws } = workspace('s1', POCKET)
    renderHost(ws)
    showSlot(true, { index: 2, focused: false })
    await flush()
    act(() => { guest().dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    expect(ws.setTiledFocusedLane).toHaveBeenCalledWith(2)
  })
})

describe('wrapperStyle (surviving mutations M8–M10)', () => {
  const rect = { x: 10, y: 20, width: 300, height: 200 }
  it('a shown page sits above the lanes but BELOW every z-50 overlay and modal', () => {
    const z = wrapperStyle({ mode: 'shown', slotKey: 'lane:0', rect, clip: null, dimmed: false }, null).zIndex as number
    expect(z).toBeGreaterThan(0)
    expect(z).toBeLessThan(50)
  })
  it('an unfocused lane\'s page dims itself (the lane overlay cannot cover it)', () => {
    expect(wrapperStyle({ mode: 'shown', slotKey: 'lane:0', rect, clip: null, dimmed: true }, null).filter).toMatch(/brightness/)
    expect(wrapperStyle({ mode: 'shown', slotKey: 'lane:0', rect, clip: null, dimmed: false }, null).filter).toBeUndefined()
  })
  it('a hidden page an agent needs stays INSIDE the window behind the app; otherwise it goes off-screen', () => {
    const painting = wrapperStyle({ mode: 'parked', size: { width: 800, height: 600 }, mustPaint: true }, null)
    expect(painting).toMatchObject({ left: 0, top: 0, zIndex: -1 })
    const idle = wrapperStyle({ mode: 'parked', size: { width: 800, height: 600 }, mustPaint: false }, null)
    expect(idle.left as number).toBeLessThan(-10_000)
    for (const style of [painting, idle]) {
      expect(style.display).not.toBe('none')
      expect(style.visibility).not.toBe('hidden')
    }
  })
})

 it('keeps requested device CSS dimensions while parked for agent screenshots', () => {
  const style = wrapperStyle({ mode: 'parked', size: { width: 1280, height: 800 }, mustPaint: true }, { width: 393, height: 852 })
  expect(style.width).toBe(393)
  expect(style.height).toBe(852)
 })
