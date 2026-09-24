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

import {
  defaultUpdateChannel,
  updateFeedFor,
  type UpdateChannel,
  type UpdateFeed,
} from '@shared/updates/updateChannel.js'

export type AutoUpdaterLike = {
  autoInstallOnAppQuit: boolean
  autoDownload: boolean
  allowDowngrade: boolean
  allowPrerelease: boolean
  disableDifferentialDownload: boolean
  forceDevUpdateConfig: boolean
  setFeedURL(options: UpdateFeed): void
  on(event: string, listener: (value?: unknown) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

export type UpdateState = 'idle' | 'disabled' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'

export type UpdateServiceOptions = {
  readonly updater: AutoUpdaterLike
  /** `version` is the running app's version, so "up to date" can say which. */
  readonly app: { readonly isPackaged: boolean; readonly version: string }
  /** MUST route through the vetoable quit choreography (app.quit / close path). */
  requestQuit(): void
  /** OS notification: for results nobody explicitly asked for (background). */
  notify(message: string): void
  /** Modal answer to an explicit menu check (#1130). Resolves true only when
   *  a `confirmLabel` was given and the user chose it. A dialog rather than a
   *  notification because notifications can be switched off per app, and a
   *  menu click that produces nothing reads as "updating is broken". */
  showMessage(message: string, confirmLabel?: string): Promise<boolean>
  readLastCheck(): number | undefined
  writeLastCheck(at: number): void
  /** The channel the user chose (#1168); undefined = not chosen yet. */
  readChannel(): UpdateChannel | undefined
  writeChannel(channel: UpdateChannel): void
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

function downloadingMessage(version: string | null): string {
  return `Agent Code ${version ?? 'update'} is available and is downloading. You'll get a notification when it's ready to install.`
}

export class UpdateService {
  private current: UpdateState = 'idle'
  private lastVersion: string | null = null
  // True from a menu check until that check's outcome has been shown. The
  // outcome arrives as an updater EVENT, not as the checkForUpdates() result,
  // so the flag carries "the user is waiting for an answer" across the gap.
  // Cleared on the first outcome so a later background result is never shown
  // as if the user had asked for it.
  private manualCheckPending = false
  private pendingInstallOnQuit = false
  // The channel whose feed the updater currently points at; null until the
  // first check applies one. Re-applying only on change keeps setFeedURL from
  // replacing the provider (and its cached state) on every check.
  private appliedChannel: UpdateChannel | null = null
  // Set when the channel changes while a check or download from the OLD
  // channel is still in flight (#1168). Its outcome arrives as ordinary
  // updater events afterwards, and must be neither announced nor installed:
  // the user just chose a different channel. The first outcome clears it and
  // starts a check on the new channel instead.
  private discardInFlight = false
  // The updater's current check. electron-updater returns the SAME promise
  // for any checkForUpdates() made while one is running ("already in
  // progress"), and it emits update-available / update-not-available BEFORE
  // that promise settles (AppUpdater.checkForUpdates / doCheckForUpdates). So
  // a check started from inside one of those events would silently get the
  // OLD check back (review round 1 of #1168). The replacement check after a
  // channel switch therefore waits for this to settle.
  private inflight: Promise<unknown> | null = null
  private installWatchdog: ReturnType<typeof setTimeout> | null = null
  private readonly minimumInterval: number

  constructor(private readonly options: UpdateServiceOptions) {
    this.minimumInterval = options.minimumCheckIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    // Defense in depth: even if a future electron-updater default flips, the
    // service re-asserts the never-auto-install invariant on every check.
    options.updater.autoInstallOnAppQuit = false
    // WHY off (review round 1 of #1168): electron-updater's default
    // autoDownload starts downloading inside its own check, before this
    // service has decided anything. After a channel switch it would download
    // the discarded old-channel update and report it ready. The service
    // starts every download itself ('update-available' → downloadUpdate()).
    options.updater.autoDownload = false
    options.updater.allowDowngrade = false
    // WHY forced off (2026-09-24, RELEASE.md "Channels"): electron-updater
    // turns allowPrerelease ON by itself whenever the running version has a
    // prerelease part (AppUpdater: `allowPrerelease =
    // hasPrereleaseComponents(currentVersion)`). Previews are built as
    // `0.1.4-preview.<date>`, so on a preview install its GitHub provider
    // would skip releases/latest, walk the release feed for another
    // "preview"-channel release, and fail looking for a `preview-mac.yml`
    // that previews deliberately do not publish. Off, it reads
    // releases/latest — the newest STABLE — which semver orders above every
    // `0.1.4-preview.*`, so a preview user is offered 0.1.4 when it ships.
    // Previews are never offered by the updater; that is the channel rule.
    options.updater.allowPrerelease = false
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
      if (this.discardStaleOutcome()) return
      this.lastVersion = typeof (info as { version?: unknown })?.version === 'string'
        ? (info as { version: string }).version
        : null
      this.set('available')
      this.answerManualCheck(downloadingMessage(this.lastVersion))
      // Download starts on its own: downloading is passive and cannot restart
      // anything; only installation is gated on the committed quit.
      void this.options.updater.downloadUpdate().catch(() => { /* error event reports it */ })
    })
    updater.on('download-progress', () => {
      if (this.discardInFlight) return
      if (this.current === 'available') this.set('downloading')
    })
    updater.on('update-downloaded', (info: unknown) => {
      if (this.discardStaleOutcome()) return
      this.lastVersion = typeof (info as { version?: unknown })?.version === 'string'
        ? (info as { version: string }).version
        : this.lastVersion
      this.set('ready')
      // Names the item that really restarts: an earlier copy pointed at a
      // "Restart to update" item that never existed (#1130).
      this.options.notify(
        `Agent Code ${this.lastVersion ?? 'update'} is ready to install. Choose Check for Updates… in the File menu to restart when you are at a safe stopping point.`,
      )
    })
    updater.on('update-not-available', () => {
      if (this.discardStaleOutcome()) return
      if (this.current === 'checking') this.set('none')
      this.answerManualCheck(this.channel === 'preview'
        ? `You're up to date on the Preview channel. Agent Code ${this.options.app.version} is the newest preview.`
        : `You're up to date. Agent Code ${this.options.app.version} is the latest version.`)
    })
    updater.on('error', (error: unknown) => {
      if (this.discardStaleOutcome()) return
      this.set('error')
      // Someone waiting on a menu check gets the dialog; otherwise this is a
      // background failure and a notification is the right weight.
      if (!this.answerManualCheck(userFacingError(error))) this.options.notify(userFacingError(error))
    })
  }

  /** True when this updater event belongs to the channel the user just left.
   *  The state goes back to idle, and the new channel is checked instead;
   *  any menu check still waiting is answered by that check. */
  private discardStaleOutcome(): boolean {
    if (!this.discardInFlight) return false
    this.discardInFlight = false
    this.lastVersion = null
    this.set('idle')
    // After the old check's promise settles, never from inside its event:
    // see `inflight`. Until then the state stays 'idle', so nothing else
    // starts a check in between.
    const previous = this.inflight ?? Promise.resolve()
    void previous.then(() => undefined, () => undefined).then(() => this.checkForUpdates(true))
    return true
  }

  /** The channel in effect: the user's choice, or the version-derived
   *  default (a preview build defaults to Preview; see updateChannel.ts). */
  get channel(): UpdateChannel {
    return this.options.readChannel() ?? defaultUpdateChannel(this.options.app.version)
  }

  /**
   * Switch channel (#1168). Takes effect without a restart: the next check
   * points the updater at the new feed.
   *
   * WHY an update found, downloading or ready on the OLD channel is dropped:
   * installing a preview after the user chose Stable (or the reverse) would
   * contradict the choice they just made. A ready update simply stops being
   * offered; one still in flight is discarded when its outcome arrives
   * (discardStaleOutcome), because electron-updater cannot cancel it.
   *
   * WHY Preview → Stable never downgrades: allowDowngrade stays off, so a
   * `0.1.4-preview.*` install is offered 0.1.4 once it ships (semver orders it
   * above every 0.1.4-preview) and nothing before that.
   */
  setChannel(channel: UpdateChannel): void {
    if (channel === this.channel && this.options.readChannel() !== undefined) return
    this.options.writeChannel(channel)
    if (this.current === 'disabled') return
    this.lastVersion = null
    this.pendingInstallOnQuit = false
    if (this.current === 'checking' || this.current === 'available' || this.current === 'downloading') {
      this.discardInFlight = true
      return
    }
    this.set('idle')
    void this.checkForUpdates(true)
  }

  /** Point the updater at the channel's feed, once per change. */
  private applyFeed(): void {
    const channel = this.channel
    if (this.appliedChannel === channel) return
    this.options.updater.setFeedURL(updateFeedFor(channel))
    // Differential download finds the previous version's blockmap by putting
    // the old version into the file name (electron-updater
    // util.blockmapFiles). The rolling preview files have fixed names, so the
    // old and new blockmap URLs would be identical, and the diff would be of
    // the new build against itself. Previews therefore always download in
    // full (and publish no blockmaps).
    this.options.updater.disableDifferentialDownload = channel === 'preview'
    this.appliedChannel = channel
  }

  /** Shows `message` if a menu check is waiting for its answer. Returns
   *  whether it did, so callers can fall back to their background surface. */
  private answerManualCheck(message: string): boolean {
    if (!this.manualCheckPending) return false
    this.manualCheckPending = false
    void this.options.showMessage(message)
    return true
  }

  private set(state: UpdateState): void {
    this.current = state
  }

  /** Read-only view: callers cannot flip the machine to 'ready' and then ask
   *  for a restart; only real downloaded-update events set that state. */
  get state(): UpdateState {
    return this.current
  }

  /** `force` bypasses the rate limit; menuCheck() passes it, because a menu
   *  click is an explicit intent. Background callers leave it off. */
  checkForUpdates(force = false): Promise<void> {
    if (this.current === 'disabled') return Promise.resolve()
    // Nothing to learn once an update is found, downloading or ready: a new
    // check would only reset the state to 'checking' and replay the same
    // version. That reset used to drop a Restart the user had just confirmed
    // (the startup, 4h and resume checks can fire while the dialog is open;
    // review finding on #1131). menuCheck answers these states itself.
    if (this.current === 'available' || this.current === 'downloading' || this.current === 'ready') {
      return Promise.resolve()
    }
    const last = this.options.readLastCheck()
    if (!force && last !== undefined && this.options.now() - last < this.minimumInterval) {
      return Promise.resolve()
    }
    this.options.writeLastCheck(this.options.now())
    // Re-asserted here, not just the constructor: the updater object is
    // long-lived and third-party; our invariant must not depend on its state
    // surviving untouched between checks.
    this.options.updater.autoInstallOnAppQuit = false
    this.options.updater.autoDownload = false
    this.options.updater.allowPrerelease = false
    this.options.updater.allowDowngrade = false
    this.applyFeed()
    this.set('checking')
    const check = this.options.updater.checkForUpdates()
    this.inflight = check
    return check.then(
      () => undefined,
      () => undefined, // the error event carries reporting
    ).finally(() => { if (this.inflight === check) this.inflight = null })
  }

  /** The File → Check for Updates… item. Every path ends in an answer to the
   *  user (#1130); the actual outcome of a fresh check arrives through the
   *  updater events and is shown by answerManualCheck. */
  async menuCheck(): Promise<void> {
    if (this.current === 'disabled') {
      // Unpackaged builds (npm run dev, electron-vite preview) have no
      // app-update.yml and are not the signed app Squirrel would replace.
      await this.options.showMessage(
        'Updates are only available in the installed Agent Code app. This copy runs from a local build, so it never updates itself.',
      )
      return
    }
    if (this.discardInFlight) {
      // A channel switch is waiting for the old channel's check or download
      // to finish; the check on the new channel that follows answers.
      this.manualCheckPending = true
      return
    }
    if (this.current === 'ready') {
      // Ask first. The menu item used to restart on the spot, which is a bad
      // surprise in an app hosting live agent sessions. Even after "Restart"
      // this is only a quit REQUEST that Keep Editing can still cancel.
      const restart = await this.options.showMessage(
        `Agent Code ${this.lastVersion ?? 'update'} is ready to install. Restart now to finish updating?`,
        'Restart',
      )
      if (restart) this.restartToUpdate()
      return
    }
    if (this.current === 'available' || this.current === 'downloading') {
      await this.options.showMessage(downloadingMessage(this.lastVersion))
      return
    }
    this.manualCheckPending = true
    // A background check already in flight will answer; starting a second
    // one would only race it.
    if (this.current === 'checking') return
    await this.checkForUpdates(true)
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
