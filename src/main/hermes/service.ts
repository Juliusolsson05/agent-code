// Main-owned Hermes connections (#1482): the Settings list, sign-in, and the
// `dial()` every Hermes pane uses. The ONE place credentials are handled.
//
// Ownership (decomposition §10): hermes-headless knows the wire; this service
// knows which connection a pane belongs to, holds its tokens, opens the
// browser, and mints a fresh ticket for every socket. The renderer only ever
// sees HermesConnectionInfo (no token can be expressed in it).

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  HermesAuthError,
  HermesHeadless,
  HermesRest,
  HermesStartError,
  backendCompatibility,
  buildWsUrl,
  wsTicketProtocols,
  normalizeBaseUrl,
  probe,
  type FetchLike,
  type HermesDial,
  type WebSocketLike,
} from 'hermes-headless'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import { loadHermesConnections, saveHermesConnections, type StoredHermesConnection } from '@main/hermes/connectionStore.js'
import { HermesTokenStore } from '@main/hermes/tokenStore.js'
import { HermesSignedOutError, HermesTokenBroker } from '@main/hermes/tokenBroker.js'
import { runNativeSignIn, SignInCancelledError } from '@main/hermes/nativeSignIn.js'
import { openWs } from '@main/hermes/openWs.js'
import { tailnetKindOfUrl } from '@shared/hermes/tailnet.js'
import {
  HERMES_PROBE_SCRIPT,
  decideHermesLocation,
  describeSshFailure,
  parseHermesProbe,
  sshArgs,
  sshCommandLine,
  validateSshDraft,
  type HermesDetection,
  type HermesSshAccess,
  type HermesSshDraft,
} from '@shared/hermes/ssh.js'
import {
  validateHermesConnectionName,
  type HermesConnectionDraft,
  type HermesConnectionInfo,
  type HermesConnectionState,
  type HermesLaneListing,
  type HermesTestResult,
} from '@shared/hermes/types.js'


export type HermesServiceDeps = {
  stateDir: string
  codec: SecretCodec
  openExternal: (url: string) => Promise<void> | void
  fetchImpl?: FetchLike
  /** Socket factory; tests inject a fake. */
  openSocket?: (url: string, protocols: string[]) => Promise<WebSocketLike>
  /** Runs the system `ssh` with `args`, `stdin` on its input (#1528). Tests inject a recording. */
  runSsh?: SshRunner
}

export type SshRunner = (args: string[], stdin: string) => Promise<{ code: number | null; stdout: string; stderr: string }>

type RuntimeState = {
  state: HermesConnectionState
  identity: HermesConnectionInfo['identity']
  backend: HermesConnectionInfo['backend']
  lastError: string | null
}

/** The pane's connection was removed in Settings (not a transient failure). */
export class HermesConnectionMissingError extends Error {
  constructor(readonly connectionId: string) {
    super('This Hermes connection no longer exists. Pick another one in Settings → Hermes.')
    this.name = 'HermesConnectionMissingError'
  }
}

/** Why live panes are told to let go of their sockets. */
export type HermesDisconnectReason = 'signed-out' | 'removed'

export class HermesConnectionService extends EventEmitter {
  private connections: StoredHermesConnection[] = []
  private readonly runtime = new Map<string, RuntimeState>()
  private readonly brokers = new Map<string, HermesTokenBroker>()
  private readonly signIns = new Map<string, AbortController>()
  private readonly tokens: HermesTokenStore
  private readonly file: string
  private loadBlocked = false

  constructor(private readonly deps: HermesServiceDeps) {
    super()
    this.file = join(deps.stateDir, 'hermes', 'connections.json')
    this.tokens = new HermesTokenStore(join(deps.stateDir, 'hermes', 'tokens'), deps.codec)
  }

  async initialize(): Promise<void> {
    const loaded = await loadHermesConnections(this.file)
    this.connections = loaded.document.connections
    this.loadBlocked = loaded.readFailed === true
    for (const connection of this.connections) {
      const tokens = await this.tokens.get(connection.id, connection.baseUrl).catch(() => null)
      this.runtime.set(connection.id, {
        state: tokens ? 'ready' : 'signed-out',
        identity: tokens ? { userId: tokens.userId, provider: tokens.provider } : null,
        backend: null,
        lastError: loaded.problem ?? null,
      })
    }
  }

  list(): HermesConnectionInfo[] {
    return this.connections.map((connection) => this.info(connection))
  }

  get(id: string): HermesConnectionInfo | null {
    const connection = this.connections.find((entry) => entry.id === id)
    return connection ? this.info(connection) : null
  }

  /** Whether ANY connection is signed in: Hermes' "detected" for Settings → Providers. */
  hasSignedInConnection(): boolean {
    return this.connections.some((connection) => this.runtime.get(connection.id)?.state !== 'signed-out')
  }

  /**
   * Settings edits run one at a time, each reading the list as the previous
   * one left it. Two windows adding a connection at once both built their
   * document from the same old list, and the second write erased the first
   * acknowledged addition (round-2 review c2 #1). Serializing only the WRITES
   * would not help: the stale list is read before the write.
   */
  private mutation: Promise<unknown> = Promise.resolve()
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.catch(() => undefined).then(operation)
    this.mutation = next.catch(() => undefined)
    return next
  }

  add(draft: HermesConnectionDraft): Promise<HermesConnectionInfo> {
    return this.serialized(() => this.addNow(draft))
  }

  update(id: string, draft: HermesConnectionDraft): Promise<HermesConnectionInfo> {
    return this.serialized(() => this.updateNow(id, draft))
  }

  remove(id: string): Promise<void> {
    return this.serialized(() => this.removeNow(id))
  }

  /**
   * Save (or, with null, forget) the connection's SSH access (#1528).
   * Serialized with every other Settings edit for the same reason they are:
   * the document is read-modify-written.
   */
  setSshAccess(id: string, draft: HermesSshDraft | null): Promise<HermesConnectionInfo> {
    return this.serialized(async () => {
      const existing = this.require(id)
      let ssh: HermesSshAccess | undefined
      if (draft) {
        const checked = validateSshDraft(draft)
        if (checked.error !== undefined) throw new Error(checked.error)
        ssh = checked.access
        // An empty container field keeps a DETECTED host install, but only
        // for the same server: a new destination is a new machine, and the
        // old answer about where Hermes lives says nothing about it.
        const previous = existing.ssh
        if (!ssh.hermes && previous?.hermes?.kind === 'host' && previous.destination === ssh.destination) {
          ssh = { ...ssh, hermes: previous.hermes }
        }
        // A typed container on the same server keeps the shell Detect found
        // (`sh` in an image without bash); validateSshDraft can only assume bash.
        if (ssh.hermes?.kind === 'docker' && previous?.hermes?.kind === 'docker' && previous.hermes.container === ssh.hermes.container && previous.destination === ssh.destination) {
          ssh = { ...ssh, hermes: { ...ssh.hermes, shell: previous.hermes.shell } }
        }
      }
      const { ssh: _old, ...rest } = existing
      const next: StoredHermesConnection = ssh ? { ...rest, ssh } : rest
      await this.persist(this.connections.map((entry) => (entry.id === id ? next : entry)))
      this.changed()
      return this.info(next)
    })
  }

  /**
   * Find where the `hermes` CLI lives on the server, over the saved SSH
   * access, and save it when there is exactly one answer. Never throws for
   * an SSH or detection failure: the sentence IS the result the Settings
   * card shows (a rejected IPC would arrive as "Error invoking remote
   * method…").
   */
  async detectHermes(id: string): Promise<HermesDetection> {
    const access = this.require(id).ssh
    if (!access) return { ok: false, message: 'Save SSH access for this connection first.' }
    // BatchMode: a probe must never sit on an invisible prompt (host key,
    // passphrase, password). It fails, and describeSshFailure says which
    // step fixes it. ConnectTimeout bounds a dead host; the runner's own
    // timeout bounds a hung remote command.
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...sshArgs(access), access.destination, 'sh', '-s']
    let run: Awaited<ReturnType<SshRunner>>
    try {
      run = await (this.deps.runSsh ?? runSystemSsh)(args, HERMES_PROBE_SCRIPT)
    } catch (error) {
      return { ok: false, message: `Could not run ssh: ${error instanceof Error ? error.message : String(error)}` }
    }
    const probe = run.code === 0 ? parseHermesProbe(run.stdout) : null
    if (!probe) {
      return { ok: false, message: run.code === 0 ? 'The server answered, but not with a complete detection result. Try again, or type the container by hand.' : describeSshFailure(run.code, run.stderr) }
    }
    const decision = decideHermesLocation(probe)
    if (decision.ok) {
      // Saved under the serialized queue, against the record as it is NOW:
      // the user may have edited SSH access while the probe ran, and an
      // answer about the OLD destination must not land on the new one.
      await this.serialized(async () => {
        const current = this.connections.find((entry) => entry.id === id)
        if (!current?.ssh || current.ssh.destination !== access.destination) return
        const next = { ...current, ssh: { ...current.ssh, hermes: decision.location } }
        await this.persist(this.connections.map((entry) => (entry.id === id ? next : entry)))
        this.changed()
      })
    }
    return decision
  }

  /**
   * The line a fresh terminal pane types to reach the server (`vps`) or a
   * shell where `hermes` works (`hermes`). Built HERE from the stored,
   * validated record, so a renderer can ask for a connection's terminal but
   * never hand main a command line of its own.
   */
  shellCommand(id: string, target: 'vps' | 'hermes'): { ok: true; command: string; name: string } | { ok: false; error: string } {
    const connection = this.require(id)
    if (!connection.ssh) return { ok: false, error: `Set up SSH access for "${connection.name}" in Settings → Hermes.` }
    const command = sshCommandLine(connection.ssh, target)
    if (!command) return { ok: false, error: `Agent Code does not know where Hermes runs on "${connection.name}" yet. Run Detect in Settings → Hermes, or type the container.` }
    return { ok: true, command, name: connection.name }
  }

  private async addNow(draft: HermesConnectionDraft): Promise<HermesConnectionInfo> {
    const { name, baseUrl } = this.validateDraft(draft, null)
    const connection: StoredHermesConnection = { id: randomUUID(), name, baseUrl, createdAt: Date.now() }
    await this.persist([...this.connections, connection])
    this.runtime.set(connection.id, { state: 'signed-out', identity: null, backend: null, lastError: null })
    this.changed()
    return this.info(connection)
  }

  private async updateNow(id: string, draft: HermesConnectionDraft): Promise<HermesConnectionInfo> {
    const existing = this.require(id)
    const { name, baseUrl } = this.validateDraft(draft, id)
    const next = { ...existing, name, baseUrl }
    await this.persist(this.connections.map((entry) => (entry.id === id ? next : entry)))
    if (baseUrl !== existing.baseUrl) {
      // Tokens are bound to the URL they were issued by (tokenStore.ts); a new
      // URL is a new backend that must be signed into. Revoke FIRST, so an
      // in-flight refresh or sign-in for the old URL cannot land afterwards.
      this.revoke(id)
      this.signIns.get(id)?.abort()
      this.disconnect(id, 'signed-out')
      await this.tokens.delete(id)
      this.setRuntime(id, { state: 'signed-out', identity: null, backend: null, lastError: null })
    }
    this.changed()
    return this.info(next)
  }

  private async removeNow(id: string): Promise<void> {
    this.require(id)
    this.signIns.get(id)?.abort()
    this.revoke(id)
    this.disconnect(id, 'removed')
    await this.persist(this.connections.filter((entry) => entry.id !== id))
    await this.tokens.delete(id)
    this.runtime.delete(id)
    this.changed()
  }

  /** Probe the backend's public endpoints (works signed out, too). */
  async test(id: string): Promise<HermesTestResult> {
    const connection = this.require(id)
    try {
      const result = await probe(connection.baseUrl, this.deps.fetchImpl)
      if (!result.authFlows.includes('native_pkce') && result.authRequired) {
        return { ok: false, error: 'This Hermes backend does not offer app sign-in (native_pkce). Update Hermes on the server.' }
      }
      this.patchRuntime(id, { backend: { version: result.version, desktopContract: this.runtime.get(id)?.backend?.desktopContract ?? null, compatibility: this.runtime.get(id)?.backend?.compatibility ?? null } })
      return { ok: true, version: result.version, authRequired: result.authRequired, providers: result.providers.map((provider) => provider.displayName) }
    } catch (error) {
      return { ok: false, error: describeError(error, connection.baseUrl) }
    }
  }

  async signIn(id: string): Promise<HermesConnectionInfo> {
    const connection = this.require(id)
    this.signIns.get(id)?.abort()
    const controller = new AbortController()
    this.signIns.set(id, controller)
    this.patchRuntime(id, { state: 'signing-in', lastError: null })
    try {
      const tokens = await runNativeSignIn(connection.baseUrl, { openExternal: this.deps.openExternal, fetchImpl: this.deps.fetchImpl }, controller.signal)
      // This attempt owns the connection while it was not cancelled or
      // superseded (Cancel, Sign out, another sign-in, a URL edit, Remove all
      // abort it) and the connection still exists at the URL the tokens were
      // issued for (review a #7). Checked now AND when the queued write runs.
      const owns = () =>
        !controller.signal.aborted &&
        this.signIns.get(id) === controller &&
        this.connections.find((entry) => entry.id === id)?.baseUrl === connection.baseUrl
      if (!owns()) throw new SignInCancelledError()
      // A fresh pair: the old broker (and anything it was refreshing) is
      // stale, so it can no longer write or delete (round-1 review c1).
      this.revoke(id)
      if (!(await this.tokens.set(id, connection.baseUrl, tokens, owns))) throw new SignInCancelledError()
      this.patchRuntime(id, { state: 'ready', identity: { userId: tokens.userId, provider: tokens.provider }, lastError: null })
      // Panes that let go of this connection when its sign-in died come back
      // on their own now (owner's debug bundle: a pane sat dead for 10m42s
      // after a fresh sign-in, until a manual reload).
      this.emit('signed-in', id)
    } catch (error) {
      // A superseded attempt publishes nothing: the newer sign-in, Sign out,
      // edit or removal that replaced it owns the state now (round-2 c2 #2).
      if (this.signIns.get(id) !== controller) {
        if (!(error instanceof SignInCancelledError)) throw error
        return this.info(connection)
      }
      const tokens = await this.tokens.get(id, connection.baseUrl).catch(() => null)
      this.patchRuntime(id, {
        state: tokens ? 'ready' : 'signed-out',
        lastError: error instanceof SignInCancelledError && !controller.signal.aborted ? error.message : error instanceof SignInCancelledError ? null : describeError(error, connection.baseUrl),
      })
      if (!(error instanceof SignInCancelledError)) throw error
    } finally {
      if (this.signIns.get(id) === controller) this.signIns.delete(id)
    }
    return this.info(connection)
  }

  cancelSignIn(id: string): void {
    this.signIns.get(id)?.abort()
  }

  async signOut(id: string): Promise<void> {
    this.require(id)
    // Hermes' bearer tokens have no revoke endpoint for native clients; the
    // password provider's are stateless. Forgetting them locally is what
    // signing out can do. A sign-in still exchanging its code must not land
    // after this (round-2 review c2 #3).
    this.signIns.get(id)?.abort()
    this.revoke(id)
    this.disconnect(id, 'signed-out')
    await this.tokens.delete(id)
    this.setRuntime(id, { state: 'signed-out', identity: null, backend: this.runtime.get(id)?.backend ?? null, lastError: null })
  }

  /** Record what a live session learned about its backend (contract number). */
  reportBackend(id: string, desktopContract: unknown, version: string | undefined): void {
    if (!this.runtime.has(id)) return
    const compatibility = backendCompatibility(desktopContract)
    this.patchRuntime(id, {
      backend: {
        version: version || this.runtime.get(id)?.backend?.version || 'unknown',
        desktopContract: compatibility.contract,
        compatibility: compatibility.kind,
      },
    })
  }

  /** Mark reachability from a live pane (a dial failed, or succeeded again). */
  reportReachability(id: string, reachable: boolean, error?: unknown): void {
    const state = this.runtime.get(id)?.state
    if (!state || state === 'signed-out' || state === 'signing-in') return
    this.patchRuntime(id, reachable ? { state: 'ready', lastError: null } : { state: 'unreachable', lastError: describeError(error, this.connections.find((entry) => entry.id === id)?.baseUrl) })
  }

  /**
   * The dial a HermesSession hands to hermes-headless: every call mints a
   * fresh single-use ticket (they live 30 s) and opens a new socket.
   */
  dialFor(id: string): HermesDial {
    return async () => {
      const connection = this.require(id)
      const broker = this.broker(connection)
      const ticket = await broker.ticket()
      // Signed out (or URL edited) while the ticket was being minted.
      broker.assertLive()
      const url = buildWsUrl(connection.baseUrl)
      const protocols = wsTicketProtocols(ticket)
      return this.deps.openSocket ? this.deps.openSocket(url, protocols) : openWs(url, protocols)
    }
  }

  /**
   * The dashboard REST client for a connection (Telegram lane lookup,
   * gateway restart). Same broker as the WebSocket, so REST never holds a
   * second copy of the tokens or refreshes on its own schedule.
   */
  restFor(id: string): HermesRest {
    // WHY a fresh client per CALL, built from one snapshot of the connection
    // and ITS broker (review #1503, high): a lane session keeps this object
    // for its lifetime. Capturing the URL once while resolving the broker per
    // call meant that after the user edited the URL and signed in to the new
    // server, the next lane refresh sent the NEW server's bearer to the OLD
    // URL. Now the URL and the token always come from the same connection
    // record (the broker is itself bound to that URL), whatever changes.
    const current = (): HermesRest => {
      const connection = this.require(id)
      const broker = this.broker(connection)
      return new HermesRest({
        baseUrl: connection.baseUrl,
        accessToken: (options) => broker.restAccessToken(options),
        fetchImpl: this.deps.fetchImpl,
      })
    }
    return {
      listSessions: (query?: Parameters<HermesRest['listSessions']>[0]) => current().listSessions(query),
      latestDescendant: (sessionId: string, profile?: string) => current().latestDescendant(sessionId, profile),
      restartGateway: () => current().restartGateway(),
    } as HermesRest
  }

  /**
   * The Telegram DM thread a new Hermes pane follows by default (#1496, plan
   * Decision 3, UNCONFIRMED), as its gateway routing key; null when the
   * server has none or cannot be asked. Never throws: a failed lookup means
   * a separate chat, not a failed pane.
   */
  async defaultLaneKey(id: string): Promise<string | null> {
    try {
      this.laneLookupFailedAt.delete(id)
      return (await HermesHeadless.defaultLane(this.restFor(id)))?.sessionKey ?? null
    } catch (error) {
      console.warn('[hermes] Telegram thread lookup failed:', describeError(error))
      // The pane that is about to open as a separate chat says why
      // (consumeLaneLookupFailure); silently opening a desktop-only chat
      // when the owner expects the thread was a review finding (#1503).
      this.laneLookupFailedAt.set(id, Date.now())
      return null
    }
  }

  /**
   * Every messaging thread on the server, for "Change Telegram Thread…"
   * (#1501). Unlike `defaultLaneKey`, this one DOES hand display names and
   * routing keys to the renderer: choosing a thread is impossible without
   * seeing them, and the user asked for exactly this list. Head ids stay
   * here (HermesLaneChoice says why).
   *
   * Never throws, and does NOT touch `laneLookupFailedAt`: that flag is the
   * "your new pane opened as a separate chat because the lookup failed"
   * notice, and a failed listing in the picker is reported in the picker.
   */
  async listLanes(id: string): Promise<HermesLaneListing> {
    try {
      const lanes = await HermesHeadless.listLanes(this.restFor(id))
      return {
        ok: true,
        lanes: lanes.map(({ sessionKey, platform, chatType, threadId, displayName, lastActiveAt }) => ({
          sessionKey, platform, chatType, threadId, displayName, lastActiveAt,
        })),
      }
    } catch (error) {
      return { ok: false, error: describeError(error, this.connections.find((entry) => entry.id === id)?.baseUrl) }
    }
  }

  /**
   * The Telegram DM thread's routing key, with NO side effects: unlike
   * defaultLaneKey it neither sets nor clears the "lookup failed" flag the
   * next pane spawn consumes. For callers that are not a pane spawn (the
   * `hermes` MCP bridge, #1512 review A F8): an agent's lookup must not make
   * an unrelated pane opened a minute later claim its own lookup failed, nor
   * erase a real failure before that pane reads it.
   */
  async lookupLaneKey(id: string): Promise<string | null> {
    try {
      return (await HermesHeadless.defaultLane(this.restFor(id)))?.sessionKey ?? null
    } catch {
      return null
    }
  }

  /** True once, for the pane spawned right after a failed thread lookup on this connection. */
  consumeLaneLookupFailure(id: string): boolean {
    const at = this.laneLookupFailedAt.get(id)
    this.laneLookupFailedAt.delete(id)
    return at !== undefined && Date.now() - at < 60_000
  }

  /** Unauthenticated `/api/status`: is the messaging gateway running? Null when unreachable. */
  async gatewayRunning(id: string): Promise<boolean | null> {
    try {
      // Inside the try: a connection removed mid-poll is "unknown", never an
      // unhandled rejection from a fire-and-forget restart watcher (review).
      const connection = this.require(id)
      const fetchImpl = this.deps.fetchImpl ?? fetch
      const response = await fetchImpl(`${connection.baseUrl.replace(/\/+$/, '')}/api/status`, { signal: AbortSignal.timeout(10_000) })
      if (!response.ok) return null
      const body = (await response.json()) as { gateway_running?: unknown }
      return body.gateway_running === true
    } catch {
      return null
    }
  }

  private readonly laneLookupFailedAt = new Map<string, number>()

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Tell live panes on this connection to let go of their sockets. Revoking
   * the broker only stops NEW dials; a socket opened before Sign out would
   * otherwise keep chatting with the server the user just signed out of
   * (review a suspicion). Not emitted on a fresh sign-in: that keeps panes up.
   */
  private disconnect(id: string, reason: HermesDisconnectReason): void {
    this.emit('disconnect', id, reason)
  }

  /** Invalidate everything the current broker has in flight, then drop it. */
  private revoke(id: string): void {
    this.brokers.get(id)?.revoke()
    this.brokers.delete(id)
  }

  private broker(connection: StoredHermesConnection): HermesTokenBroker {
    let broker = this.brokers.get(connection.id)
    if (!broker) {
      broker = new HermesTokenBroker({
        connectionId: connection.id,
        baseUrl: connection.baseUrl,
        store: this.tokens,
        fetchImpl: this.deps.fetchImpl,
        onSignedOut: (reason) => this.setRuntime(connection.id, { state: 'signed-out', identity: null, backend: this.runtime.get(connection.id)?.backend ?? null, lastError: reason }),
      })
      this.brokers.set(connection.id, broker)
    }
    return broker
  }

  private validateDraft(draft: HermesConnectionDraft, selfId: string | null): { name: string; baseUrl: string } {
    const nameProblem = validateHermesConnectionName(draft.name)
    if (nameProblem) throw new Error(nameProblem)
    const name = draft.name.trim()
    const baseUrl = normalizeBaseUrl(draft.baseUrl)
    for (const other of this.connections) {
      if (other.id === selfId) continue
      if (other.name.toLowerCase() === name.toLowerCase()) throw new Error(`A Hermes connection named "${name}" already exists.`)
      if (other.baseUrl.toLowerCase() === baseUrl.toLowerCase()) throw new Error(`"${other.name}" already points at ${baseUrl}.`)
    }
    return { name, baseUrl }
  }

  private async persist(next: StoredHermesConnection[]): Promise<void> {
    // A file that exists but could not be read must not be overwritten with
    // what we THINK it holds (connectionStore.ts).
    if (this.loadBlocked) throw new Error('Hermes connections could not be read from disk; not saving over them. Restart Agent Code.')
    await saveHermesConnections(this.file, { version: 1, connections: next })
    this.connections = next
  }

  private require(id: string): StoredHermesConnection {
    const connection = this.connections.find((entry) => entry.id === id)
    // Typed: a pane must tell "removed" (stop, say so) from a dial failure
    // (retry with backoff). A plain Error here kept a removed connection's
    // panes redialling forever.
    if (!connection) throw new HermesConnectionMissingError(id)
    return connection
  }

  private info(connection: StoredHermesConnection): HermesConnectionInfo {
    const runtime = this.runtime.get(connection.id) ?? { state: 'signed-out' as const, identity: null, backend: null, lastError: null }
    return { ...connection, ...runtime }
  }

  private setRuntime(id: string, state: RuntimeState): void {
    this.runtime.set(id, state)
    this.changed()
  }

  private patchRuntime(id: string, patch: Partial<RuntimeState>): void {
    const current = this.runtime.get(id) ?? { state: 'signed-out' as const, identity: null, backend: null, lastError: null }
    this.runtime.set(id, { ...current, ...patch })
    this.changed()
  }

  private changed(): void {
    this.emit('changed', this.list())
  }
}

/**
 * The system `ssh`, not a Node SSH library: it is what the terminals run, so
 * a probe that works proves the terminal will, with the user's own
 * ~/.ssh/config, agent, known_hosts and ProxyJump. A library would need its
 * own copy of all of that and could disagree with the terminal.
 */
const runSystemSsh: SshRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    // 30 s covers ConnectTimeout (10 s) plus a `docker exec` per container
    // on a slow server; past that the server is not answering usefully.
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin.on('error', () => undefined)
    child.stdin.end(stdin)
  })

export function describeError(error: unknown, baseUrl?: string): string {
  // A start() failure arrives wrapped with its stage; the words are about the cause.
  if (error instanceof HermesStartError) return describeError(error.cause, baseUrl)
  if (error instanceof HermesSignedOutError) return error.message
  const code = error instanceof HermesAuthError && error.kind === 'transport'
    ? error.causeCode
    : (error as { code?: unknown } | null)?.code
  // A tailnet address that cannot be reached is almost always Tailscale
  // itself (not connected on this Mac, or the ACL does not allow this
  // device), not `hermes serve` (#1498). Say that first.
  if (baseUrl && tailnetKindOfUrl(baseUrl) && typeof code === 'string' && TAILNET_NETWORK_CODES.has(code)) {
    return `This is a Tailscale address. Check that Tailscale is connected on this Mac and that this device is allowed to reach ${hostOf(baseUrl)}.`
  }
  if (error instanceof HermesAuthError) {
    if (error.kind === 'transport') {
      if (error.causeCode === 'ECONNREFUSED') return 'Hermes refused the connection. Is `hermes serve` running on the server?'
      if (error.causeCode === 'ENOTFOUND' || error.causeCode === 'EAI_AGAIN') return 'That host name could not be found. Check the URL.'
      if (error.causeCode === 'ETIMEDOUT' || error.causeCode === 'EHOSTUNREACH' || error.causeCode === 'ENETUNREACH') {
        return 'Hermes did not answer in time. Check your network or VPN (Tailscale) path to the server.'
      }
    }
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

const TAILNET_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'])

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}
