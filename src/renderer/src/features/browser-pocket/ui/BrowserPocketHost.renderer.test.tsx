import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GlobalToastProvider } from '@renderer/ui/GlobalToast'
import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { WorkspaceState } from '@renderer/workspace/types'

import { usePlacementStore } from '../placement/placementStore'
import { usePocketLiveStore } from '../state/pocketLiveStore'
import { BrowserPocketHost, wrapperStyle } from './BrowserPocketHost'

// Review B #1–#3: the guest lifecycle had no test, and that is where the
// blocking bug was. The host is rendered for real; only the Electron edge is
// faked (a <webview> element with the guest methods, and a recording
// window.api). Every guest removal must be preceded by main unregistering it.

const log: string[] = []
let original = useAppStore.getState()

function installApi() {
  const calls = {
    register: vi.fn(async (p: { pocketId: string; sessionId: string }) => { log.push(`register:${p.sessionId}`); return { ok: true } }),
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
  } as unknown as Workspace
  return { ws, updates }
}

function showSlot(visible = true) {
  act(() => usePlacementStore.getState().report('p1', { slotKey: 'lane:0', surface: 'lane', laneIndex: 0, focused: true, visible, dimmed: false, rect: { x: 0, y: 0, width: 800, height: 600 }, clip: null }))
}

function guest(url = 'http://localhost:3000/'): HTMLElement & { url: string } {
  const el = document.querySelector('webview') as HTMLElement & Record<string, unknown>
  Object.assign(el, {
    url,
    getWebContentsId: () => 7, getURL() { return this.url as string }, canGoBack: () => false, canGoForward: () => false,
    loadURL: async () => {}, reload: () => {}, reloadIgnoringCache: () => {}, goBack: () => {}, goForward: () => {}, openDevTools: () => {},
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
})
afterEach(() => { cleanup(); useAppStore.setState(original, true) })

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
