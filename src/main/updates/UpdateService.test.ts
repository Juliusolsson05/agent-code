import { describe, expect, it, vi } from 'vitest'

import { UpdateService, type AutoUpdaterLike } from './UpdateService.js'

// UpdateService is the safety-critical core of auto-update: everything that
// could kill a live session is encoded here as tests, because the one thing
// this app must never do is restart itself over running agents. The real
// electron-updater object never appears in unit tests — the injected fake
// proves OUR behavior; the real one is exercised by packaging + release feed
// verification only.

type Recorded = { event: string; listener: (value?: unknown) => void }

class FakeUpdater implements AutoUpdaterLike {
  autoInstallOnAppQuit = true // deliberately wrong; the service must force it off
  allowDowngrade = true
  forceDevUpdateConfig = false
  checked = 0
  downloaded = 0
  installed = 0
  quitAndInstallCalls = 0
  failCheck: Error | null = null
  private listeners: Recorded[] = []
  on(event: string, listener: (value?: unknown) => void): this {
    this.listeners.push({ event, listener })
    return this
  }
  emit(event: string, value?: unknown): void {
    for (const record of this.listeners.filter(entry => entry.event === event)) record.listener(value)
  }
  async checkForUpdates(): Promise<unknown> {
    this.checked += 1
    if (this.failCheck) throw this.failCheck
    return null
  }
  async downloadUpdate(): Promise<unknown> {
    this.downloaded += 1
    return null
  }
  quitAndInstall(): void {
    this.quitAndInstallCalls += 1
    this.installed += 1
  }
}

function fixture(overrides: Partial<ConstructorParameters<typeof UpdateService>[0]> = {}) {
  const updater = new FakeUpdater()
  const quits: number[] = []
  const notified: string[] = []
  const storage = new Map<string, number>()
  let clock = 1_000
  const service = new UpdateService({
    updater,
    app: { isPackaged: true },
    requestQuit: () => { quits.push(clock) },
    notify: message => { notified.push(message) },
    readLastCheck: () => storage.get('lastCheck'),
    writeLastCheck: value => { storage.set('lastCheck', value) },
    now: () => clock,
    log: () => {},
    ...overrides,
  })
  return { service, updater, quits, notified, advance: (ms: number) => { clock += ms } }
}

const available = (updater: FakeUpdater) => {
  updater.emit('update-available', { version: '9.9.9' })
  updater.emit('download-progress', { percent: 50 })
  updater.emit('update-downloaded', { version: '9.9.9' })
}

describe('UpdateService invariants', () => {
  it('never lets the updater auto-install on quit, even if constructed that way', () => {
    const { updater } = fixture()
    expect(updater.autoInstallOnAppQuit).toBe(false)
  })

  it('is a silent no-op in unpackaged (dev) builds — one log line, no checks', () => {
    const log = vi.fn()
    const { updater } = fixture({ app: { isPackaged: false }, log })
    expect(updater.checked).toBe(0)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('runs the happy path: checking → available → downloading → ready + notification', () => {
    const { service, updater, notified } = fixture()
    void service.checkForUpdates(true)
    expect(updater.checked).toBe(1)
    updater.emit('update-available', { version: '9.9.9' })
    updater.emit('update-downloaded', { version: '9.9.9' })
    expect(service.state).toBe('ready')
    expect(notified).toEqual(['Agent Code 9.9.9 is ready to install. Use Restart to update when you are at a safe stopping point.'])
  })

  it('rate-limits unforced checks but always allows a manual one', () => {
    const { service, updater, advance } = fixture()
    void service.checkForUpdates(true)
    void service.checkForUpdates()
    expect(updater.checked).toBe(1)
    advance(25 * 60 * 60 * 1000)
    void service.checkForUpdates()
    expect(updater.checked).toBe(2)
  })

  it('no update available settles to none without noise', () => {
    const { service, updater, notified } = fixture()
    void service.checkForUpdates(true)
    updater.emit('update-not-available')
    expect(service.state).toBe('none')
    expect(notified).toEqual([])
  })

  it.each([
    ['offline', new Error('net::ERR_INTERNET_DISCONNECTED'), /offline|network/i],
    ['rate limited', Object.assign(new Error('Too many requests'), { code: 403 }), /later/i],
    ['signature mismatch', new Error('Code signature mismatch'), /signed/i],
  ])('maps %s errors to actionable user copy', (_label, error, pattern) => {
    const { service, updater, notified } = fixture()
    void service.checkForUpdates(true)
    updater.emit('error', error)
    expect(service.state).toBe('error')
    expect(notified.join(' ')).toMatch(pattern)
  })
})

describe('restartToUpdate safety', () => {
  it('refuses to restart until an update is downloaded', () => {
    const { service, quits, updater } = fixture()
    expect(service.restartToUpdate()).toBe(false)
    expect(quits).toEqual([])
    expect(updater.quitAndInstallCalls).toBe(0)
  })

  it('requests the vetoable quit path; the GATE installs only after drain', () => {
    const { service, updater, quits } = fixture()
    void service.checkForUpdates(true)
    available(updater)
    expect(service.restartToUpdate()).toBe(true)
    expect(quits).toHaveLength(1)
    // Quit requested but not committed: installing now would bypass the
    // Keep-Editing veto AND latch MacUpdater's one-shot quitAndInstall.
    expect(updater.quitAndInstallCalls).toBe(0)
    expect(service.pendingInstall()).toBe(true)
    service.installUpdate()
    expect(updater.quitAndInstallCalls).toBe(1)
    expect(service.pendingInstall()).toBe(false)
  })

  it('a vetoed quit (Keep Editing) resets cleanly; retry still installs', () => {
    const { service, updater } = fixture()
    void service.checkForUpdates(true)
    available(updater)
    service.restartToUpdate()
    service.onQuitVetoed()
    expect(updater.quitAndInstallCalls).toBe(0)
    expect(service.state).toBe('ready')
    service.restartToUpdate()
    service.installUpdate()
    expect(updater.quitAndInstallCalls).toBe(1)
  })

  it('a plain quit without a pending update never triggers the installer', () => {
    const { service, updater } = fixture()
    expect(service.pendingInstall()).toBe(false)
    service.installUpdate()
    expect(updater.quitAndInstallCalls).toBe(0)
  })

  it('the install watchdog restores retryability instead of force-exiting', () => {
    vi.useFakeTimers()
    try {
      const { service, updater, notified } = fixture({ installWatchdogMs: 1_000 })
      void service.checkForUpdates(true)
      available(updater)
      service.restartToUpdate()
      service.installUpdate()
      expect(service.pendingInstall()).toBe(false)
      vi.advanceTimersByTime(1_001)
      expect(service.state).toBe('ready')
      expect(notified.at(-1)).toMatch(/did not finish/i)
    } finally { vi.useRealTimers() }
  })
})
