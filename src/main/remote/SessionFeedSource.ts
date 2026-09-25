import type { SessionManager } from '@main/sessionManager.js'
import type { OutboundSessionSummary } from '@main/remote/protocol/messages.js'
import type {
  RawPtyChannel,
  SessionFeedTap,
  SessionFeedTapChannel,
} from '@main/sessions/sessionFeedTap.js'

// SessionFeedSource — the REMOTE SINK over the shared SessionFeedTap.
//
// Doctrine change (#1177). This used to be a second, independent subscriber
// on SessionManager that re-implemented the forwarder's discipline under an
// isolation rule: "remote adapts to core, core never grows remote-shaped
// parameters", with the duplication accepted as the price. The copies
// drifted — the phone had no semantic coalescer and so none of its ordering
// barriers, lacked two channels, had lost the JSONL interning, and ran a
// second sub-agent watcher over the same directories. Ordering now lives
// ONCE in main/sessions/sessionFeedTap.ts, which is transport-neutral (it
// knows no windows or sockets), and this class only adds what is genuinely
// remote:
//   - the session list the phone's picker shows (listSessions);
//   - the terminal gate, at ONE choke point (onSinkEvent);
//   - forwarding `removed`, which the desktop sink drops.
// Remote must NOT re-implement ordering here again. If the phone needs a
// different cadence, add it as a sink-side policy on top of the tap's order,
// never a second copy of the order.
//
// What the old wall protected still holds, because it never depended on the
// duplication: the phone's command surface is the inbound protocol schema
// (protocol/messages.ts), which cannot express spawn, kill, raw input or
// provider switching; and raw PTY channels (terminal-data / agent-pty-data /
// terminal-foreground) are opt-in per tap sink and this sink never opts in,
// so a compromised remote client cannot even OBSERVE raw terminal bytes.
//
// Channel names mirror the SessionFeed listener names: RemoteServer wraps
// each callback into a { type: 'session-event', channel, payload } frame, and
// the phone's WebSocketSessionFeed switches on `channel` to invoke the
// matching listener set — a straight line from manager event to phone
// callback.

export type FeedChannel = Exclude<SessionFeedTapChannel, RawPtyChannel>

export type FeedEventListener = (channel: FeedChannel, payload: unknown) => void

type Unsubscribe = () => void

type TrackedSession = {
  sessionId: string
  kind: string
  cwd: string | null
  alive: boolean
}

export class SessionFeedSource {
  private readonly listeners = new Set<FeedEventListener>()
  private readonly sessions = new Map<string, TrackedSession>()
  private readonly manager: SessionManager
  private readonly tap: SessionFeedTap
  private detachSink: Unsubscribe | null
  private disposed = false

  /**
   * @param tap MUST be the same tap the desktop forwarder sinks from (main
   *   index.ts builds one per manager). A private tap here would bring back a
   *   second sub-agent watcher and a second, independently timed copy of
   *   every coalescer — the drift this class used to be.
   */
  constructor(manager: SessionManager, tap: SessionFeedTap) {
    this.manager = manager
    this.tap = tap
    // Seed from sessions that are ALREADY live: the remote server is
    // typically enabled long after agents started, and 'started' events for
    // those fired before this sink existed. Without seeding, the feature's
    // headline flow (walk away from running agents, monitor from the phone)
    // shows an empty list until a brand-new session spawns.
    for (const sessionId of manager.list()) {
      const kind = manager.getSessionKind(sessionId)
      if (!kind || kind === 'terminal') continue
      this.sessions.set(sessionId, {
        sessionId,
        kind,
        cwd: manager.getSpawnCwd(sessionId),
        alive: true,
      })
    }
    // No `rawPty` option: see the module comment. The tap filters those
    // channels before this sink is ever called.
    this.detachSink = tap.addSink((channel, payload) => {
      this.onSinkEvent(channel as FeedChannel, payload)
    })
  }

  onEvent(listener: FeedEventListener): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  listSessions(): OutboundSessionSummary[] {
    // lastActivityAt is read FRESH per call rather than tracked in the map:
    // the manager already maintains it for every relayed event, and the list
    // is only materialized on connect/state changes — no reason to duplicate
    // a hot-path counter here.
    return [...this.sessions.values()].map(s => ({
      ...s,
      lastActivityAt: this.manager.getLastActivityAt(s.sessionId),
    }))
  }

  /** The tap's latest sub-agent fleet for a session, so RemoteServer can
   *  prime its late-joiner cache the same way it primes screens from the
   *  manager. Needed now that the watcher is shared: it emits only on
   *  change, and a fleet that has not changed since remote was enabled
   *  would otherwise never reach the phone. Gated like every other frame. */
  getSubAgentsSnapshot(sessionId: string): unknown {
    if (this.isTerminal(sessionId)) return null
    return this.tap.getSubAgentsSnapshot(sessionId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Detach only THIS sink. The tap is shared with the desktop and lives as
    // long as the manager, so disabling remote must never stop its watchers
    // or unsubscribe it — "remote off costs nothing" now means "no sink",
    // not "no subscriber".
    this.detachSink?.()
    this.detachSink = null
    this.listeners.clear()
    this.sessions.clear()
  }

  private onSinkEvent(channel: FeedChannel, payload: { sessionId: string }): void {
    if (this.disposed) return
    const { sessionId } = payload
    // ONE gate at the choke point, not per channel (#866). The terminal filter
    // used to exist only on `started`, so every other channel (readiness, exit,
    // process-state) still relayed terminal ids, and a client could act on an
    // id it was never shown. Any future channel is covered automatically.
    //
    // Terminal sessions are OUT of the remote feed on purpose: their output
    // is raw PTY bytes, which this sink never receives, so listing them would
    // show a session that can never render output while still accepting
    // composer input — an invisible command-execution surface on the phone.
    // When a later phase adds terminals, it must add the data channel and the
    // protocol surface together.
    if (this.isTerminal(sessionId)) return

    if (channel === 'started') {
      const started = payload as { sessionId: string; kind: string; projectDir?: string }
      // The event's own kind is the earliest word on it; checked in addition
      // to the registry gate above so a terminal can never enter the list.
      if (started.kind === 'terminal') return
      this.sessions.set(sessionId, {
        sessionId,
        kind: started.kind,
        // Spawn cwd over the event's projectDir: for Claude, projectDir is
        // the TRANSCRIPT directory (~/.claude/projects/...), not the
        // workspace — useless as a picker label.
        cwd: this.manager.getSpawnCwd(sessionId) ?? started.projectDir ?? null,
        alive: true,
      })
    } else if (channel === 'exit') {
      const tracked = this.sessions.get(sessionId)
      if (tracked) tracked.alive = false
    } else if (channel === 'removed') {
      // `removed` = the session left the manager entirely (kill or natural
      // teardown after exit). Forwarded to listeners (the desktop sink drops
      // it) because remote clients have no other signal on the
      // removed-without-exit paths; only for sessions we ever tracked, so an
      // id the phone was never shown is never announced as removed.
      const tracked = this.sessions.delete(sessionId)
      if (!tracked) return
    }

    for (const listener of [...this.listeners]) listener(channel, payload)
  }

  private isTerminal(sessionId: string): boolean {
    // WHY the gate falls back to getSpawnKind (#866 follow-up): a spawn
    // publishes `input-readiness {ready:false, reason:'starting'}` (main
    // sessionManager.ts ~:2501) BEFORE inserting the RegistryEntry that
    // getSessionKind reads (~:3113 for terminals). In that pre-registration
    // window getSessionKind returns null even for a terminal spawn, so the
    // gate above alone let the very first readiness frame for every new
    // terminal leak through — and because later `exit`/`removed` frames for
    // that id ARE filtered (the entry is registered by then), the leaked
    // frame stuck around forever in RemoteServer.lastInputReadiness with no
    // event to ever evict it. getSpawnKind reads spawnInfo, which is set at
    // the same moment as the 'starting' emit, so it never has this gap.
    //
    // Evaluated at DELIVERY time, which for coalesced channels is up to
    // 100 ms after the manager event. That is safe because terminals never
    // emit the coalesced channels (screen / process-state / semantic-event
    // come only from agent sessions), and `removed` flushes every buffer
    // synchronously while the registry entry still exists.
    return (this.manager.getSessionKind(sessionId) ?? this.manager.getSpawnKind(sessionId)) === 'terminal'
  }
}
