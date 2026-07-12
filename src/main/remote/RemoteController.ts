import { EventEmitter } from 'node:events'
import { join } from 'node:path'

import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import type { SessionManager } from '@main/sessionManager.js'

import { DevicePairing } from '@main/remote/auth/DevicePairing.js'
import { DeviceRegistry } from '@main/remote/auth/deviceRegistry.js'
import type { PairedDevice } from '@main/remote/auth/deviceRegistry.js'
import { loadOrCreateRemoteSecret, REMOTE_STATE_DIR } from '@main/remote/auth/secret.js'
import { RemoteServer } from '@main/remote/RemoteServer.js'
import { SessionFeedSource } from '@main/remote/SessionFeedSource.js'
import { LanTransport } from '@main/remote/transport/LanTransport.js'
import { CloudflaredTunnel } from '@main/remote/transport/CloudflaredTunnel.js'
import type { RemoteTransport } from '@main/remote/transport/RemoteTransport.js'
import { transcribeBatch } from '@main/dictation/controller.js'
import { wrapWithSttTag } from 'agent-voice-dictation/composer'

// RemoteController — the one object the desktop drives.
//
// The remote subsystem has real moving parts (secret, registry, pairing,
// feed tap, HTTP+WS server, transport), but the desktop's mental model is
// a light switch plus a device list. This controller owns that translation:
// remote:* IPC handlers are one-liners onto it, and the whole subsystem is
// constructed HERE, not in main/index.ts — index.ts gets exactly one
// `new RemoteController(...)` line (the isolation boundary's construction
// hole) and never sees the internals.
//
// Lifecycle rules:
//   - Everything durable (secret, registry) lazy-loads on first enable()
//     and persists across disable/enable cycles — pairing survives toggling
//     the server off overnight.
//   - Everything live (feed tap, server, transport) is created on enable()
//     and torn down on disable() — a disabled remote subsystem holds NO
//     manager subscriptions and NO sockets, so its steady-state cost when
//     off is zero. That property is why this is safe to ship default-off.

export type RemoteTransportMode = 'lan' | 'tunnel'

// #495 A11: doEnable's rethrow reaches the RemotePanel error line verbatim
// (ipc/remote.ts passes it through, the panel's withBusy() renders
// `err.message`). Raw Node bind errors read like
// "listen EADDRINUSE: address already in use 0.0.0.0:52341" — accurate but
// actionless for the user staring at the Remote panel. Translate ONLY the
// two errno families a bind can realistically hit on macOS into copy that
// says what to do next; everything else (including the deliberate loud
// tunnel-unavailable error from buildTransport) passes through untouched.
// The original error rides along as `cause` so journals/devtools keep the
// full errno + syscall detail. This is a message mapper, not a policy
// change: the rethrow semantics (teardown first, caller sees a rejection)
// and the controller's documented no-auto-fallback stance are unchanged.
//
// Gated on the bind SIGNATURE, not the errno alone (codex follow-up on
// #507): doEnable's catch sees every failure in the enable path, and
// EACCES/EPERM also come out of loadOrCreateRemoteSecret() and
// DeviceRegistry.load() when ~/.config/agent-code/remote is unwritable —
// translating those would misreport a filesystem-permission problem as
// "macOS blocked the network bind" and send the user to Firewall settings
// that can't help. Node tags server.listen() failures with
// `syscall: 'listen'` (that is exactly the error LanTransport /
// CloudflaredTunnel reject with off the server's 'error' event), so that
// field IS the bind shape; anything without it keeps its own message.
function translateBindError(err: unknown): unknown {
  if ((err as NodeJS.ErrnoException | null)?.syscall !== 'listen') return err
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'EADDRINUSE') {
    return new Error(
      'The port the remote server picked is already in use — try enabling again ' +
        '(a fresh port is chosen each time).',
      { cause: err },
    )
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new Error(
      'macOS blocked the network bind. Check System Settings → Network → Firewall ' +
        'and allow incoming connections for Agent Code, then try again.',
      { cause: err },
    )
  }
  return err
}

export type RemoteStatus = {
  enabled: boolean
  url: string | null
  /** Which transport the live server is on; null while disabled. */
  transport: RemoteTransportMode | null
  /** Whether the tunnel option can work on this install (cloudflared binary
   *  resolvable). LAN is ALWAYS available — the feature never depends on
   *  cloudflared for local use. */
  tunnelAvailable: boolean
  devices: PairedDevice[]
  connectedDeviceIds: string[]
}

export type RemoteControllerDeps = {
  manager: SessionManager
  journal?: AppRunJournal | null
  /** Override the durable-state root (secret, devices.json). Tests point
   *  this at a tmpdir; production uses REMOTE_STATE_DIR. */
  stateDir?: string
  /** Built remote-client bundle dir; resolved by main at construction. */
  clientDistDir?: string | null
  /** Resolve the bundled cloudflared binary. Injected from main (which owns
   *  Electron-aware path resolution — see setup/runtimeTools.ts) so this
   *  controller stays testable without Electron. Absent/null-returning →
   *  tunnel mode reports unavailable and enable('tunnel') fails with a
   *  clear message while LAN keeps working. */
  resolveTunnelBinary?: () => Promise<string | null>
  /** Transport factory override for tests. When set it wins over mode. */
  createTransport?: () => RemoteTransport
}

export class RemoteController extends EventEmitter {
  private readonly stateDir: string
  private registry: DeviceRegistry | null = null
  private pairing: DevicePairing | null = null
  private feedSource: SessionFeedSource | null = null
  private server: RemoteServer | null = null
  private url: string | null = null
  private transport: RemoteTransportMode | null = null
  private tunnelBinary: string | null | undefined = undefined
  private themeSettings: Record<string, unknown> | null = null
  /** Serialization chain for enable/disable. Every transition queues behind
   *  the previous one — this is what makes rapid toggle/switch clicks safe.
   *  The previous design coalesced onto an in-flight enable promise, which
   *  had TWO races the review caught: a same-tick enable('tunnel') during
   *  enable('lan') silently returned the LAN result (mode ignored), and the
   *  mode-switch path awaited disable() BEFORE claiming the guard, letting a
   *  double-click construct two live servers. A strict FIFO chain retires
   *  the whole class: later calls observe the state their predecessors left
   *  and no-op when it already matches. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: RemoteControllerDeps) {
    super()
    this.stateDir = deps.stateDir ?? REMOTE_STATE_DIR
  }

  getStatus(): RemoteStatus {
    return {
      enabled: this.server !== null && this.url !== null,
      url: this.url,
      transport: this.server !== null && this.url !== null ? this.transport : null,
      // `undefined` = not probed yet. Report optimistically until the first
      // tunnel-enable attempt resolves the binary; the panel only needs an
      // accurate value after a failed attempt, which is exactly when this
      // becomes a concrete false.
      tunnelAvailable: this.tunnelBinary !== null,
      devices: this.registry?.list() ?? [],
      connectedDeviceIds: this.server?.connectedDeviceIds() ?? [],
    }
  }

  async enable(mode: RemoteTransportMode = 'lan'): Promise<RemoteStatus> {
    return this.runExclusive(async () => {
      // Same mode already live: idempotent no-op. Different mode: clean
      // switch — every socket drops (URL and reachability change anyway;
      // phones reconnect via their feed's backoff, and paired tokens
      // survive because pairing is durable state).
      if (this.server && this.url) {
        if (this.transport === mode) return this.getStatus()
        await this.teardownLive()
        this.emit('status-changed', this.getStatus())
      }
      return this.doEnable(mode)
    })
  }

  private async doEnable(mode: RemoteTransportMode): Promise<RemoteStatus> {
    try {
      // Transport FIRST: it is the most likely failure (tunnel binary
      // missing) and allocates nothing that needs teardown, whereas
      // SessionFeedSource subscribes to SessionManager the moment it is
      // constructed. Building the tap before a throwing transport leaked a
      // full set of manager listeners per failed enable attempt (review
      // finding) — construction order IS the resource-safety argument here.
      const transport = this.deps.createTransport?.() ?? (await this.buildTransport(mode))
      const secret = await loadOrCreateRemoteSecret(this.stateDir)
      if (!this.registry) {
        this.registry = new DeviceRegistry(join(this.stateDir, 'devices.json'))
        await this.registry.load()
      }
      this.pairing = new DevicePairing({ secret, registry: this.registry })
      this.feedSource = new SessionFeedSource(this.deps.manager)
      this.server = new RemoteServer({
        manager: this.deps.manager,
        feedSource: this.feedSource,
        pairing: this.pairing,
        registry: this.registry,
        transport,
        clientDistDir: this.deps.clientDistDir ?? null,
        getThemeSettings: () => this.themeSettings,
        journal: this.deps.journal ?? null,
        transcribeAudio: async (audio, mimeType) => {
          // The Deepgram key stays here in the main process — the phone never
          // receives it. Mirrors ipc/dictation's env-only key resolution and
          // the desktop's wrapWithSttTag composer wrapping so a phone-dictated
          // prompt reads to the agent exactly like a desktop-dictated one.
          const apiKey = process.env.DEEPGRAM_API_KEY?.trim()
          if (!apiKey) return { ok: false, error: 'no-key' }
          try {
            const outcome = await transcribeBatch({
              provider: 'deepgram',
              apiKey,
              audio,
              ...(mimeType ? { mimeType } : {}),
            })
            // Empty transcript ('no-speech') is a normal outcome, not an error:
            // return ok with empty text so the phone just appends nothing.
            if (outcome.kind === 'no-speech') return { ok: true, text: '' }
            return { ok: true, text: wrapWithSttTag(outcome.raw) }
          } catch (err) {
            this.deps.journal?.recordError('remote_dictate.transcribe_error', err)
            return { ok: false, error: 'transcribe-failed' }
          }
        },
        // MUST match transcribeAudio's own key gate above — this is what the
        // server advertises in the WS hello so the phone disables its mic
        // instead of recording into a guaranteed 503. Env-read per call so a
        // key exported before a phone (re)connects is picked up without a
        // desktop restart.
        isSttAvailable: () => Boolean(process.env.DEEPGRAM_API_KEY?.trim()),
      })
      this.transport = mode
      this.server.on('clients-changed', () => this.emitStatus())
      const { url } = await this.server.start()
      this.url = url
    } catch (err) {
      // Whatever partially came up, tear it ALL down so a retry starts
      // clean — teardownLive disposes the feed tap even when the server was
      // never constructed. (start() journals its own incidents.)
      await this.teardownLive()
      throw translateBindError(err)
    }
    const status = this.getStatus()
    this.emit('status-changed', status)
    return status
  }

  async disable(): Promise<RemoteStatus> {
    return this.runExclusive(async () => {
      if (!this.server) return this.getStatus()
      await this.teardownLive()
      const status = this.getStatus()
      this.emit('status-changed', status)
      return status
    })
  }

  setThemeSettings(settings: Record<string, unknown> | null): void {
    // WHY RemoteController stores renderer appearance as an opaque record:
    // the authoritative Settings type lives in the renderer bundle, but the
    // remote server is a main-process feature. Main does not interpret these
    // fields; it only relays the snapshot to paired phones, where the remote
    // client merges it into DEFAULT_SETTINGS and runs the normal applyTheme().
    this.themeSettings = settings
    this.server?.broadcastThemeSettings()
  }

  /** FIFO transition queue — see the `chain` field's WHY. Failures propagate
   *  to THEIR caller but never poison the chain for the next transition. */
  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Mint a fresh one-time pairing code and the URL to encode in the QR.
   * The code rides the URL fragment (`#code=…`) so it never appears in
   * server request logs — fragments are not sent over HTTP; the client JS
   * reads it locally and POSTs it to /pair itself.
   */
  issuePairingCode(): { code: string; expiresAt: number; pairUrl: string } {
    if (!this.pairing || !this.url) {
      throw new Error('remote server is not enabled')
    }
    const { code, expiresAt } = this.pairing.issuePairingCode()
    return { code, expiresAt, pairUrl: `${this.url}/#code=${code}` }
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    if (!this.registry) {
      // Revocation must work even before the first enable of this app run —
      // the registry is durable state, not live state.
      this.registry = new DeviceRegistry(join(this.stateDir, 'devices.json'))
      await this.registry.load()
    }
    const revoked = await this.registry.revoke(deviceId)
    if (revoked) this.emitStatus()
    return revoked
  }

  async dispose(): Promise<void> {
    await this.teardownLive()
    this.removeAllListeners()
  }

  /** Build the transport for a mode. LAN needs nothing; tunnel resolves the
   *  bundled cloudflared and fails LOUDLY (not silently falling back to LAN
   *  — the user asked for internet reachability; giving them a LAN URL
   *  instead would misrepresent what the QR exposes). */
  private async buildTransport(mode: RemoteTransportMode): Promise<RemoteTransport> {
    if (mode === 'lan') return new LanTransport()
    if (this.tunnelBinary === undefined) {
      this.tunnelBinary = (await this.deps.resolveTunnelBinary?.()) ?? null
    }
    if (!this.tunnelBinary) {
      throw new Error(
        'Internet tunnel unavailable: the bundled cloudflared binary was not ' +
          'found. Run `npm run runtime:fetch:cloudflared` (dev) or reinstall ' +
          'the packaged app. LAN mode works without it.',
      )
    }
    return new CloudflaredTunnel({ binaryPath: this.tunnelBinary })
  }

  private async teardownLive(): Promise<void> {
    const server = this.server
    this.server = null
    this.url = null
    this.transport = null
    this.pairing = null
    if (server) await server.stop()
    this.feedSource?.dispose()
    this.feedSource = null
  }

  private emitStatus(): void {
    this.emit('status-changed', this.getStatus())
  }
}
