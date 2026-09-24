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
  // electron-updater sets this true itself for a prerelease-versioned app
  // (a preview build); the service must force it off.
  allowPrerelease = true
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
  // Dialog messages are recorded apart from notifications on purpose: #1130
  // is exactly that a manual check must reach the user even when OS
  // notifications are off, so tests assert WHICH surface carried the copy.
  const messages: string[] = []
  const answers = { confirm: false }
  const storage = new Map<string, number>()
  let clock = 1_000
  const service = new UpdateService({
    updater,
    app: { isPackaged: true, version: '0.1.1' },
    requestQuit: () => { quits.push(clock) },
    notify: message => { notified.push(message) },
    showMessage: async message => { messages.push(message); return answers.confirm },
    readLastCheck: () => storage.get('lastCheck'),
    writeLastCheck: value => { storage.set('lastCheck', value) },
    now: () => clock,
    log: () => {},
    ...overrides,
  })
  return { service, updater, quits, notified, messages, answers, advance: (ms: number) => { clock += ms } }
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

  it('a preview build is only ever offered stable releases, never another preview', () => {
    // A preview reports `0.1.4-preview.<date>`, for which electron-updater
    // switches allowPrerelease on by itself; left on, it looks for a
    // preview-channel feed file that previews never publish.
    const { updater } = fixture({ app: { isPackaged: true, version: '0.1.4-preview.20260924' } })
    expect(updater.allowPrerelease).toBe(false)
    expect(updater.allowDowngrade).toBe(false)
  })

  it('is a silent no-op in unpackaged (dev) builds — one log line, no checks', () => {
    const log = vi.fn()
    const { updater } = fixture({ app: { isPackaged: false, version: '0.1.1' }, log })
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
    // Names the menu item that really restarts (#1130: the old copy named a
    // "Restart to update" item that never existed).
    expect(notified).toEqual(['Agent Code 9.9.9 is ready to install. Choose Check for Updates… in the File menu to restart when you are at a safe stopping point.'])
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

  it('a background check with no update settles to none without noise', () => {
    const { service, updater, notified, messages } = fixture()
    void service.checkForUpdates()
    updater.emit('update-not-available')
    expect(service.state).toBe('none')
    expect(notified).toEqual([])
    expect(messages).toEqual([])
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

// #1130: choosing Check for Updates… used to say nothing unless a download
// finished or failed. Every outcome of a MANUAL check must now answer the
// user, in a dialog (visible even with notifications off). Background checks
// keep their silence, apart from the ready/error notifications above.
describe('manual check feedback', () => {
  it('explains why a build run from source never updates, without touching the updater', async () => {
    const { service, updater, messages } = fixture({ app: { isPackaged: false, version: '0.1.1' } })
    await service.menuCheck()
    expect(updater.checked).toBe(0)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/only available in the installed Agent Code app/)
  })

  it('says the user is up to date, naming the running version', async () => {
    const { service, updater, messages, notified } = fixture()
    const check = service.menuCheck()
    updater.emit('update-not-available')
    await check
    expect(messages).toEqual(["You're up to date. Agent Code 0.1.1 is the latest version."])
    expect(notified).toEqual([])
  })

  it('says which version was found and that it is downloading, exactly once', async () => {
    const { service, updater, messages } = fixture()
    const check = service.menuCheck()
    updater.emit('update-available', { version: '0.1.3' })
    updater.emit('download-progress', { percent: 10 })
    updater.emit('download-progress', { percent: 60 })
    await check
    expect(messages).toEqual(["Agent Code 0.1.3 is available and is downloading. You'll get a notification when it's ready to install."])
    expect(updater.downloaded).toBe(1)
  })

  it('reports a failed manual check in the dialog instead of a notification', async () => {
    const { service, updater, messages, notified } = fixture()
    const check = service.menuCheck()
    updater.emit('error', new Error('HttpError: 404 Not Found'))
    await check
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(/Update check failed/)
    expect(notified).toEqual([])
  })

  it('a later background result is not reported as if the user had asked', async () => {
    const { service, updater, messages, advance } = fixture()
    const check = service.menuCheck()
    updater.emit('update-not-available')
    await check
    advance(5 * 60 * 60 * 1000)
    void service.checkForUpdates()
    updater.emit('update-not-available')
    expect(messages).toHaveLength(1)
  })

  it('a click during an in-flight background check is answered by that check, without a second check', async () => {
    // Both reviewers flagged this branch as untested: menuCheck adopts the
    // running check instead of racing it, so its outcome must still reach
    // the user who clicked.
    const { service, updater, messages } = fixture()
    void service.checkForUpdates()
    await service.menuCheck()
    updater.emit('update-not-available')
    expect(updater.checked).toBe(1)
    expect(messages).toEqual(["You're up to date. Agent Code 0.1.1 is the latest version."])
  })

  it('while a download is in flight, says so instead of starting another check', async () => {
    const { service, updater, messages } = fixture()
    void service.checkForUpdates()
    updater.emit('update-available', { version: '0.1.3' })
    await service.menuCheck()
    expect(updater.checked).toBe(1)
    expect(messages).toEqual(["Agent Code 0.1.3 is available and is downloading. You'll get a notification when it's ready to install."])
  })

  it('when an update is ready, asks before restarting; Later leaves the app running', async () => {
    const { service, updater, quits, messages, answers } = fixture()
    void service.checkForUpdates(true)
    available(updater)
    answers.confirm = false
    await service.menuCheck()
    expect(messages.at(-1)).toMatch(/9\.9\.9 is ready to install/)
    expect(quits).toEqual([])
    expect(service.pendingInstall()).toBe(false)
  })

  it('a background check while the Restart dialog is open cannot swallow the answer', async () => {
    // Review finding on #1131: checkForUpdates used to reset 'ready' to
    // 'checking', and the startup / 4h / resume checks call it. A Restart
    // confirmed during that window reached restartToUpdate() in the wrong
    // state and was silently dropped.
    const { service, updater, quits, answers, advance } = fixture()
    void service.checkForUpdates(true)
    available(updater)
    const checksBefore = updater.checked
    answers.confirm = true
    const dialog = service.menuCheck()
    advance(5 * 60 * 60 * 1000)
    void service.checkForUpdates()
    await dialog
    expect(updater.checked).toBe(checksBefore)
    expect(quits).toHaveLength(1)
    expect(service.pendingInstall()).toBe(true)
  })

  it('when an update is ready and the user chooses Restart, takes the vetoable quit path', async () => {
    const { service, updater, quits, answers } = fixture()
    void service.checkForUpdates(true)
    available(updater)
    answers.confirm = true
    await service.menuCheck()
    expect(quits).toHaveLength(1)
    // Still only a quit REQUEST: the shutdown gate installs after drain, so
    // Keep Editing can cancel exactly as for a window close.
    expect(updater.quitAndInstallCalls).toBe(0)
    expect(service.pendingInstall()).toBe(true)
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
      expect(notified.at(-1)).toMatch(/did not finish.*relaunch/i)
    } finally { vi.useRealTimers() }
  })
})
