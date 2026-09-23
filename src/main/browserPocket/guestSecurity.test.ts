import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Review A #1/#10: the permission, certificate, download, navigation and popup
// rules had no test, so granting every permission, trusting every certificate,
// dropping the popup scheme check or the will-redirect guard all survived
// mutation. These drive the real handlers against fake Electron objects.

const sessions = new Map<string, FakeSession>()
class FakeSession extends EventEmitter {
  permissionRequest: ((wc: unknown, permission: string, cb: (ok: boolean) => void) => void) | null = null
  permissionCheck: ((wc: unknown, permission: string) => boolean) | null = null
  certVerify: ((req: { hostname: string }, cb: (code: number) => void) => void) | null = null
  setPermissionRequestHandler(h: FakeSession['permissionRequest']) { this.permissionRequest = h }
  setPermissionCheckHandler(h: FakeSession['permissionCheck']) { this.permissionCheck = h }
  setCertificateVerifyProc(h: FakeSession['certVerify']) { this.certVerify = h }
}
vi.mock('electron', () => ({
  session: { fromPartition: (name: string) => { if (!sessions.has(name)) sessions.set(name, new FakeSession()); return sessions.get(name)! } },
}))

const { configurePocketSession } = await import('./partition')
const { attachGuestInput, attachGuestSecurity } = await import('./guestPolicies')
const { installGuestGuard, POCKET_PARTITION_PREFIX } = await import('./guestGuard')

beforeEach(() => sessions.clear())

describe('pocket session handlers', () => {
  // configurePocketSession remembers configured partitions for the process
  // lifetime (a partition always maps to the same Electron session), so each
  // test uses its own partition name.
  let n = 0
  const partition = () => `${POCKET_PARTITION_PREFIX}t${++n}`
  it('grants only clipboard writes, through BOTH the request and the check handler', () => {
    const s = configurePocketSession(partition()) as unknown as FakeSession
    for (const permission of ['media', 'geolocation', 'notifications', 'clipboard-read', 'camera', 'fullscreen', 'openExternal']) {
      let granted: boolean | undefined
      s.permissionRequest!(null, permission, ok => { granted = ok })
      expect({ permission, granted }).toEqual({ permission, granted: false })
      expect(s.permissionCheck!(null, permission)).toBe(false)
    }
    let write: boolean | undefined
    s.permissionRequest!(null, 'clipboard-sanitized-write', ok => { write = ok })
    expect(write).toBe(true)
  })

  it('trusts self-signed certificates only for loopback names', () => {
    const s = configurePocketSession(partition()) as unknown as FakeSession
    const verdict = (hostname: string) => { let code = -99; s.certVerify!({ hostname }, c => { code = c }); return code }
    expect(verdict('localhost')).toBe(0)
    expect(verdict('app.localhost')).toBe(0)
    expect(verdict('127.0.0.1')).toBe(0)
    expect(verdict('example.com')).toBe(-3)
    expect(verdict('localhost.evil.com')).toBe(-3)
  })

  it('refuses downloads', () => {
    const s = configurePocketSession(partition()) as unknown as FakeSession
    const event = { preventDefault: vi.fn() }
    s.emit('will-download', event)
    expect(event.preventDefault).toHaveBeenCalled()
  })
})

describe('the window guard configures the session at ATTACH, without any IPC', () => {
  it('a webview created straight from renderer script still gets the handlers and the navigation rules', () => {
    const contents = new EventEmitter()
    installGuestGuard({ webContents: contents } as never, { onBlockedPopup: () => {} })
    const P = `${POCKET_PARTITION_PREFIX}direct`
    const event = { preventDefault: vi.fn() }
    contents.emit('will-attach-webview', event, {}, { partition: P, src: 'https://evil.example/' })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(sessions.get(P)?.permissionRequest).toBeTruthy()

    const guest = fakeGuest()
    contents.emit('did-attach-webview', {}, guest)
    expect(guest.openHandler).toBeTruthy()
    expect(guest.listenerCount('will-navigate')).toBe(1)
  })

  it('a webpreferences partition override cannot move the guest out of the validated partition', () => {
    // Electron merges the tag's `webpreferences="partition=…"` into the
    // prefs it hands us; the session is created from THOSE prefs.
    const contents = new EventEmitter()
    installGuestGuard({ webContents: contents } as never, { onBlockedPopup: () => {} })
    const P = `${POCKET_PARTITION_PREFIX}declared`
    const prefs: Record<string, unknown> = { partition: 'persist:unprotected', session: {} }
    const event = { preventDefault: vi.fn() }
    contents.emit('will-attach-webview', event, prefs, { partition: P, src: 'http://localhost:3000/', webpreferences: 'partition=persist:unprotected' })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(prefs.partition).toBe(P)
    expect(prefs.session).toBeUndefined()
    expect(sessions.get(P)?.permissionRequest).toBeTruthy()
  })

  it('a refused attach configures nothing', () => {
    const contents = new EventEmitter()
    installGuestGuard({ webContents: contents } as never, { onBlockedPopup: () => {} })
    contents.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { partition: 'persist:other', src: 'https://x/' })
    expect(sessions.size).toBe(0)
  })
})

function fakeGuest() {
  const guest = Object.assign(new EventEmitter(), {
    openHandler: null as null | ((d: { url: string; disposition: string }) => { action: string }),
    loadURL: vi.fn(async () => {}),
    setWindowOpenHandler(h: (d: { url: string; disposition: string }) => { action: string }) { this.openHandler = h },
  })
  return guest
}

describe('guest navigation and popups', () => {
  it('a popup to a non-web scheme is denied and never loaded', () => {
    const g = fakeGuest()
    const blocked = vi.fn()
    attachGuestSecurity(g as never, { onBlockedPopup: blocked })
    expect(g.openHandler!({ url: 'file:///etc/passwd', disposition: 'foreground-tab' })).toEqual({ action: 'deny' })
    expect(g.loadURL).not.toHaveBeenCalled()
    expect(blocked).not.toHaveBeenCalled()
  })
  it('a _blank link loads in the same pocket; a real popup is refused with an offer', () => {
    const g = fakeGuest()
    const blocked = vi.fn()
    attachGuestSecurity(g as never, { onBlockedPopup: blocked })
    g.openHandler!({ url: 'https://docs.example/', disposition: 'foreground-tab' })
    expect(g.loadURL).toHaveBeenCalledWith('https://docs.example/')
    g.openHandler!({ url: 'https://accounts.example/oauth', disposition: 'new-window' })
    expect(blocked).toHaveBeenCalledWith('https://accounts.example/oauth')
  })
  it.each(['will-navigate', 'will-redirect'])('%s to file: or a custom scheme is prevented; http is not', event => {
    const g = fakeGuest()
    attachGuestSecurity(g as never, { onBlockedPopup: () => {} })
    for (const [url, prevented] of [['file:///etc/hosts', true], ['agent-code-ext://x/y', true], ['https://ok.example/', false]] as const) {
      const e = { preventDefault: vi.fn() }
      g.emit(event, e, url)
      expect({ url, prevented: e.preventDefault.mock.calls.length > 0 }).toEqual({ url, prevented })
    }
  })
})

describe('guest input', () => {
  const key = (type: string, key: string, code: string, mods: Partial<{ meta: boolean; alt: boolean; shift: boolean; control: boolean }> = {}) =>
    ({ type, key, code, meta: false, alt: false, shift: false, control: false, ...mods })

  it('only a key-DOWN counts as the user taking control', () => {
    const g = fakeGuest()
    const human = vi.fn()
    attachGuestInput(g as never, { forwardChord: vi.fn(), localAction: vi.fn(), onHumanInput: human, agentTyping: () => false })
    g.emit('before-input-event', { preventDefault: vi.fn() }, key('keyUp', 'a', 'KeyA'))
    expect(human).not.toHaveBeenCalled()
    g.emit('before-input-event', { preventDefault: vi.fn() }, key('keyDown', 'a', 'KeyA'))
    expect(human).toHaveBeenCalledTimes(1)
  })

  it('while the agent is typing, ⌘W goes to the page — never forwarded to the app as "close tab"', () => {
    const g = fakeGuest()
    const forward = vi.fn()
    let typing = true
    attachGuestInput(g as never, { forwardChord: forward, localAction: vi.fn(), onHumanInput: vi.fn(), agentTyping: () => typing })
    const e1 = { preventDefault: vi.fn() }
    g.emit('before-input-event', e1, key('keyDown', 'w', 'KeyW', { meta: true }))
    expect(forward).not.toHaveBeenCalled()
    expect(e1.preventDefault).not.toHaveBeenCalled()
    typing = false
    g.emit('before-input-event', { preventDefault: vi.fn() }, key('keyDown', 'w', 'KeyW', { meta: true }))
    expect(forward).toHaveBeenCalledTimes(1)
  })
})
