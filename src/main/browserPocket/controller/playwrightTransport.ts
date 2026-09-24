import type { ConnectOverCDPTransport, Page } from 'playwright-core'
import type { ActionCtx, GuestLike } from './BrowserPocketController.js'

type Message = { id: number; method: string; params?: Record<string, any>; sessionId?: string }
const PAGE_SESSION = 'pocket-page'

/** Electron exposes a page debugger; Playwright expects a browser connection.
 * Supply the small Browser/Target envelope for ONE page, then pass page and
 * descendant-frame traffic to Chromium unchanged. This is the same boundary
 * used by VS Code's browserView CDP proxy, reduced to our single-page model.
 *
 * There is no TCP listener, remote-debugging switch or access to the app's
 * renderer. In particular Target.getTargets cannot enumerate other agents,
 * and an arbitrary sessionId never reaches Electron's debugger. Playwright
 * owns actionability, frame traversal, selectors and input; this adapter owns
 * only routing and the human-takeover boundary.
 */
export class PocketPlaywrightTransport implements ConnectOverCDPTransport {
  onmessage?: (message: object) => void
  onclose?: (reason?: string) => void
  closed = false
  private readonly childSessions = new Set<string>()
  private readonly heldKeys = new Set<string>()
  private readonly heldButtons = new Set<'left' | 'right' | 'middle'>()
  private attached = false
  private nativeSession: string | null = null
  private context: ActionCtx | null = null
  private readonly targetId: string

  constructor(private readonly guest: GuestLike, private readonly version: string, targetId?: string) {
    this.targetId = targetId ?? `pocket-${guest.id}`
    guest.debugger.on('message', this.onEvent)
    guest.debugger.on('detach', this.onDetach)
  }

  setAction(context: ActionCtx | null): void { this.context = context }

  /** Playwright's press() does not unwind modifiers if a later key fails.
   * Record only library-issued codes, and release through public APIs so
   * Chromium AND Playwright's cached keyboard/mouse state agree next time.
   * This is cleanup, never a replacement key map or browser action engine. */
  async releaseInputs(page: Page): Promise<void> {
    for (const code of [...this.heldKeys].reverse()) await page.keyboard.up(code)
    for (const button of [...this.heldButtons]) await page.mouse.up({ button })
  }

  send(raw: object): void {
    const message = raw as Message
    if (!Number.isInteger(message.id) || typeof message.method !== 'string') throw new Error('Invalid Playwright CDP request')
    void this.dispatch(message).then(
      result => this.deliver({ id: message.id, sessionId: message.sessionId, result }),
      error => this.deliver({ id: message.id, sessionId: message.sessionId, error: { code: -32000, message: error instanceof Error ? error.message : 'Browser command failed' } }),
    )
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.guest.debugger.removeListener?.('message', this.onEvent)
    this.guest.debugger.removeListener?.('detach', this.onDetach)
    if (this.nativeSession && this.guest.debugger.isAttached()) {
      void this.guest.debugger.sendCommand('Target.detachFromTarget', { sessionId: this.nativeSession }).catch(() => {})
    }
    this.nativeSession = null
    this.childSessions.clear()
    this.context = null
    // Disconnecting Playwright must never close the user's page or detach
    // the shared debugger: the controller also owns console/picker traffic.
    this.onclose?.()
  }

  private deliver(message: object): void { if (!this.closed) this.onmessage?.(message) }
  private readonly onDetach = () => this.close()
  private readonly onEvent = (_event: unknown, method: string, params: any, sessionId?: string) => {
    if (!this.attached || !sessionId || (sessionId !== this.nativeSession && !this.childSessions.has(sessionId))) return
    if (method === 'Target.attachedToTarget') this.childSessions.add(params.sessionId)
    if (method === 'Target.detachedFromTarget') this.childSessions.delete(params.sessionId)
    this.deliver({ method, params, sessionId: sessionId === this.nativeSession ? PAGE_SESSION : sessionId })
  }

  private targetInfo() {
    return { targetId: this.targetId, type: 'page', title: this.guest.getTitle(), url: this.guest.getURL(), attached: true, canAccessOpener: false, browserContextId: 'pocket-default' }
  }

  private async dispatch({ method, params = {}, sessionId }: Message): Promise<unknown> {
    if (this.closed || this.guest.isDestroyed()) throw new Error('Browser connection closed')
    if (!sessionId) {
      switch (method) {
        case 'Browser.getVersion': return { protocolVersion: '1.3', product: `Chrome/${this.version}`, revision: '', userAgent: this.guest.getUserAgent?.() ?? `Mozilla/5.0 (${process.platform === 'darwin' ? 'Macintosh' : process.platform === 'win32' ? 'Windows' : 'Linux'}) Chrome/${this.version}`, jsVersion: '' }
        case 'Target.getTargetInfo':
          if (params.targetId && params.targetId !== this.targetId) throw new Error('Target is outside this pocket')
          return { targetInfo: this.targetInfo() }
        case 'Target.getTargets': return { targetInfos: [this.targetInfo()] }
        case 'Target.getBrowserContexts': return { browserContextIds: [] }
        case 'Target.setAutoAttach':
          if (params.autoAttach && !this.attached) {
            // A separate session is essential: the controller has already
            // enabled Runtime for console buffers, and enabling it again on
            // that same session does not replay executionContextCreated.
            // Missing those events makes Playwright wait forever for the main
            // world (caught by the real iframe click test).
            const attached = await this.guest.debugger.sendCommand('Target.attachToTarget', { targetId: this.targetId, flatten: true })
            if (this.closed) {
              void this.guest.debugger.sendCommand('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => {})
              throw new Error('Browser connection closed')
            }
            this.nativeSession = attached.sessionId
            this.attached = true
            this.deliver({ method: 'Target.attachedToTarget', params: { sessionId: PAGE_SESSION, targetInfo: this.targetInfo(), waitingForDebugger: false } })
          }
          return {}
        // These are default-context bookkeeping, not permission to change
        // Electron's session policies or open/close a native browser window.
        case 'Target.setDiscoverTargets': case 'Browser.setDownloadBehavior': case 'Browser.resetPermissions': return {}
        default: throw new Error(`Browser command ${method} is not available in a pocket`)
      }
    }
    if (sessionId !== PAGE_SESSION && !this.childSessions.has(sessionId)) throw new Error('Session is outside this pocket')
    if (method === 'Target.getTargetInfo' && !params.targetId) return { targetInfo: this.targetInfo() }
    // Auto-attach discovers only children of the guest. Never forward target
    // enumeration/creation/attachment commands that could escape this scope.
    if (method.startsWith('Target.') && method !== 'Target.setAutoAttach' && method !== 'Target.detachFromTarget') throw new Error(`Target command ${method} is not available in a pocket`)
    if (method === 'Target.detachFromTarget' && !this.childSessions.has(params.sessionId)) throw new Error('Session is outside this pocket')
    if (method.startsWith('Browser.')) throw new Error(`Browser command ${method} is not available in a pocket`)

    // Playwright may retry after an overlay moves or a locator re-resolves.
    // Checking only at tool entry would let those retries click after the
    // human took over. Validate every outgoing step against the active call.
    // Releases are allowed to finish so cancellation cannot leave keys held.
    const release = (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') || (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp')
    const key = typeof params.code === 'string' && params.code ? params.code : params.key
    // Track attempted presses too: Playwright updates its local state BEFORE
    // sending CDP, including a press that our takeover gate refuses.
    if (method === 'Input.dispatchKeyEvent' && params.type !== 'keyUp' && typeof key === 'string') this.heldKeys.add(key)
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed' && ['left', 'right', 'middle'].includes(params.button)) this.heldButtons.add(params.button)
    if (!release) this.context?.checkEpoch()
    if (method.startsWith('Input.')) {
      if (!this.context && !release) throw new Error('No active browser action')
      if (typeof params.x === 'number' && typeof params.y === 'number') {
        this.context?.expectPointer(params.x, params.y)
        // Releasing a held button after takeover must not overwrite the
        // paused UI with a fresh "agent driving" event.
        if (!release) this.context?.pointer(params.x, params.y)
      } else this.context?.expectKeys()
    }
    const result = await this.guest.debugger.sendCommand(method, params, sessionId === PAGE_SESSION ? this.nativeSession! : sessionId)
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') this.heldKeys.delete(key)
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') this.heldButtons.delete(params.button)
    return result
  }
}
