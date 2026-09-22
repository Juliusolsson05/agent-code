// The auto-update safety core. electron-updater does the transport; this
// service owns the ONE decision that matters in an app whose whole purpose is
// hosting live terminal sessions: an update never applies by itself, and when
// the user does ask for it, the application rides the same vetoable quit path
// as a window close (#945) instead of calling quitAndInstall() directly —
// "Keep Editing" must still be able to cancel an update restart.
//
// Everything Electron-shaped is injected (updater, app flag, quit request,
// storage, clock), so unit tests drive every invariant without Electron. The
// production wiring lives in src/main/index.ts.

export type AutoUpdaterLike = {
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  forceDevUpdateConfig: boolean
  on(event: string, listener: (value?: unknown) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export type UpdateState = 'idle' | 'disabled' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'

export type UpdateServiceOptions = {
  readonly updater: AutoUpdaterLike
  readonly app: { readonly isPackaged: boolean }
  /** MUST route through the vetoable quit choreography (app.quit / close path). */
  requestQuit(): void
  notify(message: string): void
  readLastCheck(): number | undefined
  writeLastCheck(at: number): void
  now(): number
  log(line: string): void
  readonly minimumCheckIntervalMs?: number
  readonly installWatchdogMs?: number
}

// 4h between automatic checks (consulted recommendation): frequent enough to
// land a release the same working day, rare enough to respect anonymous
// GitHub rate limits. Manual menu checks bypass this entirely.
const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** Map updater failures into product copy. Raw errors from Squirrel/electron
 *  internals leak stack-shaped jargon; the user needs the next action. */
function userFacingError(error: unknown): string {
  const text = error instanceof Error ? `${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error)
  if (/ERR_INTERNET_DISCONNECTED|ENOTFOUND|EAI_AGAIN|network|fetch failed/i.test(text)) {
    return 'Update check failed: you appear to be offline. Will retry automatically later.'
  }
  if (/403|429|too many requests|rate limit/i.test(text)) {
    return 'Update check was rate-limited by GitHub. Try again later.'
  }
  if (/signatur/i.test(text)) {
    return 'The downloaded update is not signed for this copy of Agent Code. Nothing was changed; this is expected if you run a locally built app — download releases manually instead.'
  }
  return 'Update check failed. Nothing was changed; try again from the menu later.'
}

export class UpdateService {
  private current: UpdateState = 'idle'
  private lastVersion: string | null = null
  private pendingInstallOnQuit = false
  private installWatchdog: ReturnType<typeof setTimeout> | null = null
  private readonly minimumInterval: number

  constructor(private readonly options: UpdateServiceOptions) {
    this.minimumInterval = options.minimumCheckIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    // Defense in depth: even if a future electron-updater default flips, the
    // service re-asserts the never-auto-install invariant on every check.
    options.updater.autoInstallOnAppQuit = false
    options.updater.allowDowngrade = false
    if (!options.app.isPackaged) {
      // Dev/unsigned builds have no app-update.yml and no signed feed; probing
      // would only produce noise. One log line, then permanent silence.
      this.current = 'disabled'
      options.log('updates: unpackaged build — self-update disabled')
      this.wireListeners()
      return
    }
    this.wireListeners()
  }

  private wireListeners(): void {
    const { updater } = this.options
    updater.on('update-available', (info: unknown) => {
      this.lastVersion = typeof (info as { version?: unknown })?.version === 'string'
        ? (info as { version: string }).version
        : null
      this.set('available')
      // Download starts on its own: downloading is passive and cannot restart
      // anything; only installation is gated on the committed quit.
      void this.options.updater.downloadUpdate().catch(() => { /* error event reports it */ })
    })
    updater.on('download-progress', () => { if (this.current === 'available') this.set('downloading') })
    updater.on('update-downloaded', (info: unknown) => {
      this.lastVersion = typeof (info as { version?: unknown })?.version === 'string'
        ? (info as { version: string }).version
        : this.lastVersion
      this.set('ready')
      this.options.notify(
        `Agent Code ${this.lastVersion ?? 'update'} is ready to install. Use Restart to update when you are at a safe stopping point.`,
      )
    })
    updater.on('update-not-available', () => { if (this.current === 'checking') this.set('none') })
    updater.on('error', (error: unknown) => {
      this.set('error')
      this.options.notify(userFacingError(error))
    })
  }

  private set(state: UpdateState): void {
    this.current = state
  }

  /** Read-only view: callers cannot flip the machine to 'ready' and then ask
   *  for a restart; only real downloaded-update events set that state. */
  get state(): UpdateState {
    return this.current
  }

  /** Manual checks bypass the rate limit (menu item is an explicit intent). */
  checkForUpdates(force = false): Promise<void> {
    if (this.current === 'disabled') return Promise.resolve()
    const last = this.options.readLastCheck()
    if (!force && last !== undefined && this.options.now() - last < this.minimumInterval) {
      return Promise.resolve()
    }
    this.options.writeLastCheck(this.options.now())
    // Re-asserted here, not just the constructor: the updater object is
    // long-lived and third-party; our invariant must not depend on its state
    // surviving untouched between checks.
    this.options.updater.autoInstallOnAppQuit = false
    this.set('checking')
    return this.options.updater.checkForUpdates().then(
      () => undefined,
      () => undefined, // the error event carries reporting
    )
  }

  /** True when the quit was requested. False when no update is ready. */
  restartToUpdate(): boolean {
    if (this.current !== 'ready') return false
    this.pendingInstallOnQuit = true
    // Deliberately NOT quitAndInstall(): this must be the same vetoable path
    // a window close takes, so unsaved-work observers can still cancel.
    this.options.requestQuit()
    return true
  }

  /** The shutdown gate asks this after drain resolved (real committed quit). */
  pendingInstall(): boolean {
    return this.pendingInstallOnQuit
  }

  /** Called BY THE GATE, replacing the final app.quit(): quitAndInstall
   *  re-enters will-quit, where shutdownComplete admits it immediately, runs
   *  onQuitAllowed (lock release, journal) and lets Squirrel relaunch. Called
   *  only when pendingInstall() was true — MacUpdater latches
   *  quitAndInstallCalled forever, so a premature call would brick every
   *  later attempt this session. */
  installUpdate(): void {
    if (!this.pendingInstallOnQuit) return
    this.pendingInstallOnQuit = false
    this.options.updater.quitAndInstall()
    // Watchdog (consulted): if ShipIt never takes over, do NOT app.exit —
    // that races it. Say so, restore retryability, keep the app usable.
    this.installWatchdog = setTimeout(() => {
      // Honest degraded-path copy (consulted review): the committed quit already
      // drained every session and latched the gate, so an in-process retry
      // cannot work — a second quit exits without consulting pending(). The
      // staged download survives on disk; a relaunch + menu check re-reaches
      // 'ready' from the fresh state.
      this.set('ready')
      this.options.notify('The update did not finish installing. Quit and relaunch Agent Code, then use Check for Updates to retry.')
    }, this.options.installWatchdogMs ?? 10_000)
    this.installWatchdog?.unref?.()
  }

  /** Wire to the window-close-vetoed observer ("Keep Editing"): the veto
   *  lands before will-quit, so quitAndInstall was never latched. The staged
   *  update survives on disk; only the intent resets. */
  onQuitVetoed(): void {
    this.pendingInstallOnQuit = false
    if (this.installWatchdog) { clearTimeout(this.installWatchdog); this.installWatchdog = null }
  }

  get version(): string | null {
    return this.lastVersion
  }
}
