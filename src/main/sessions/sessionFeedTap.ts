import type { SessionManager } from '@main/sessionManager.js'
import type {
  AgentScreenSnapshot,
  AgentTranscriptEntry,
  AgentTranscriptObservationMetadata,
} from '@shared/types/session.js'
import type { SubAgentState } from '@preload/api/types.js'
import { makeStringPool, internEntryFields } from '@main/sessions/internEntry.js'
import { SemanticEventIpcCoalescer } from '@main/sessions/semanticEventCoalescer.js'
import { LatestSessionIpcCoalescer } from '@main/sessions/latestSessionIpcCoalescer.js'
import { SubAgentWatcherManager } from '@main/subagents/index.js'

// SessionFeedTap — the ONE main-side reader of SessionManager's session event
// stream, and the one owner of every ordering and batching decision made on it
// before the events leave main (#1177).
//
// WHY this exists. There used to be two independent subscribers:
// `forwarder.ts` (desktop windows) and `remote/SessionFeedSource.ts` (the
// phone). Each re-implemented the same discipline, and the copies drifted in
// ways that showed up as a worse phone:
//   - the phone had no semantic 100 ms coalescer and therefore none of its
//     ordering barriers: a cumulative semantic preview could land AFTER the
//     committed JSONL row that superseded it, or after turn_completed;
//   - the phone never received `transcript-diagnostic` or
//     `provider-session-changed`;
//   - the JSONL burst coalescer existed twice (one module-global copy, one
//     class-local copy that had already lost the #288 interning and the Codex
//     observation sidecar);
//   - a second SubAgentWatcherManager polled the same sidecar directories the
//     desktop's already watched.
// The old doctrine accepted that duplication as the price of a one-way
// isolation wall ("remote adapts to core, core never grows remote-shaped
// parameters"). The duplication turned out to be where the bugs lived. This
// tap is the replacement: it is TRANSPORT-NEUTRAL, not remote-shaped. It knows
// nothing about windows, Electron IPC or sockets; it emits `(channel,
// payload)` to any number of sinks. The desktop window router and the remote
// server are both just sinks. What the old wall actually protected still
// holds, because it never lived here: the phone's command surface (the inbound
// protocol schema) cannot express spawn, kill, raw input or provider
// switching, and raw PTY bytes are opt-in per sink (see `rawPty` below), so a
// remote sink never even observes them.
//
// Import rule for this file: nothing from `@main/window/*`, `electron` or
// `@main/remote/*`. The moment the tap knows a transport, a second transport
// has to re-implement it again, which is the exact failure this file ends.
//
// Ordering is identical for every sink because it is decided ONCE, here,
// before fan-out. Each sink sees the same sequence of (channel, payload) pairs
// — a sink may drop channels it does not carry (the window sink drops
// `removed`; the remote sink drops terminal sessions), but it can never see
// two events in a different order than another sink does.

/**
 * Channels the tap emits. Names are the SessionFeed listener names (and the
 * suffix of the desktop's `session:*` IPC channels), so a sink maps them
 * mechanically rather than owning a translation table that could drift.
 */
export type SessionFeedTapChannel =
  | 'started'
  | 'input-readiness'
  | 'screen'
  | 'jsonl-entries'
  | 'jsonl-error'
  | 'history-boundary'
  | 'transcript-diagnostic'
  | 'provider-session-changed'
  | 'semantic-event'
  | 'conditions'
  | 'process-state'
  | 'sub-agents'
  | 'exit'
  // The session left the manager entirely. Distinct from 'exit' because
  // SessionManager has removed-WITHOUT-exit paths (tmux-backed terminal
  // detach, spawn-failure rollback, explicit kill). The desktop learns
  // removal through workspace state and ignores it; the phone has no other
  // signal and prunes its list on it.
  | 'removed'
  | RawPtyChannel

/**
 * Terminal-only channels delivered ONLY to sinks registered with
 * `{ rawPty: true }`. terminal-data / agent-pty-data are raw PTY bytes;
 * terminal-foreground is shell-activity metadata that only a pane rendering a
 * live terminal consumes. Opt-in (rather than a filter each sink must
 * remember) so that forgetting is safe: a new sink that says nothing never
 * receives terminal bytes — that is what keeps a compromised remote client
 * from even OBSERVING raw terminal output.
 */
export type RawPtyChannel = 'terminal-data' | 'agent-pty-data' | 'terminal-foreground'

/** Every tap payload is session-scoped; the rest of the shape is per channel
 *  and identical to the SessionManager event (or the coalesced form of it). */
export type SessionFeedTapPayload = { sessionId: string }

export type SessionFeedSink = (channel: SessionFeedTapChannel, payload: SessionFeedTapPayload) => void

export type SessionFeedSinkOptions = {
  /** Receive the RawPtyChannel channels. Default false. */
  rawPty?: boolean
}

type PendingJsonlBuffer = {
  entries: Array<{
    entry: AgentTranscriptEntry
    file: string
    observation?: AgentTranscriptObservationMetadata
  }>
  flushScheduled: boolean
  // #288: per-session string pool. The coalescer is the choke point every
  // live `jsonl-entry` flows through, and the entries it forwards are the
  // exact ~24k objects main retains. Interning their duplicated metadata
  // (cwd/sessionId/role/type — see internEntry.ts) here means the canonical
  // strings are shared across the whole session's worth of entries, not
  // re-minted per `JSON.parse` upstream. The pool lives on the per-session
  // buffer so it is dropped together with the buffer when the session is
  // removed — a session-scoped lifetime, never a global leak.
  intern: (s: unknown) => unknown
}

type SinkRegistration = { sink: SessionFeedSink; rawPty: boolean }

export class SessionFeedTap {
  private readonly sinks: SinkRegistration[] = []
  private readonly detach: Array<() => void> = []
  // Per-session JSONL burst buffers. Instance state rather than the old
  // module-global map in jsonlCoalescer.ts: a module global was shared by
  // every forwarder in the process (tests, harnesses), so one harness's
  // pending burst could be flushed into another's wire. One tap, one buffer.
  private readonly jsonlPending = new Map<string, PendingJsonlBuffer>()
  // Latest sub-agent fleet per parent session. The watcher emits only on
  // CHANGE, so a sink that attaches late (the remote server is enabled long
  // after agents started) would otherwise never learn a fleet that has not
  // changed since. When the phone owned a private watcher this happened by
  // accident — a fresh watcher's first poll re-emitted the whole map. The
  // shared watcher needs an explicit read instead. Dropped on `removed`.
  private readonly lastSubAgents = new Map<string, { sessionId: string; subAgents: Record<string, SubAgentState> }>()
  private readonly screens: LatestSessionIpcCoalescer<{ sessionId: string } & AgentScreenSnapshot>
  private readonly processStates: LatestSessionIpcCoalescer<{ sessionId: string; active: boolean; status?: string }>
  private readonly semanticEvents: SemanticEventIpcCoalescer
  // The ONE sub-agent watcher per session. Driven off the main transcript
  // stream (jsonl-entry carries the transcript `file` the subagents dir is
  // derived from, and the tool_result blocks that flip a subagent to
  // done/error). See src/main/subagents/. There used to be a second instance
  // in the remote tap polling the same directories.
  private readonly subAgents: SubAgentWatcherManager
  private disposed = false

  constructor(manager: SessionManager) {
    this.subAgents = new SubAgentWatcherManager((sessionId, map) => {
      const payload = { sessionId, subAgents: map }
      this.lastSubAgents.set(sessionId, payload)
      this.emit('sub-agents', payload)
    })
    this.screens = new LatestSessionIpcCoalescer(payload => this.emit('screen', payload))
    this.processStates = new LatestSessionIpcCoalescer(payload => this.emit('process-state', payload))
    this.semanticEvents = new SemanticEventIpcCoalescer(
      payload => this.emit('semantic-event', payload),
      undefined,
      sessionId => {
        // See SemanticEventIpcCoalescer.beforeBarrier. These are full snapshots / committed entries,
        // so flushing them cannot lose information and prevents an older delayed value from landing
        // after turn_completed or another structural semantic boundary.
        this.screens.flush(sessionId)
        this.processStates.flush(sessionId)
        this.flushJsonl(sessionId)
      },
    )

    // Every subscription is recorded so dispose() leaves the manager exactly
    // as it found it. Typed as the manager's own `on` so each handler below
    // still gets its event's payload type inferred.
    const on: SessionManager['on'] = (event, listener) => {
      manager.on(event, listener)
      this.detach.push(() => manager.off(event, listener))
      return manager
    }

    on('started', payload => this.emit('started', payload))
    on('input-readiness', payload => this.emit('input-readiness', payload))
    // WHY screen/process-state are not delivered directly: both are complete,
    // authoritative snapshots. During a nine-agent burst the old path cloned
    // and dispatched every intermediate repaint even though the next snapshot
    // made it obsolete. Latest-per-session delivery is lossless at the state
    // level and keeps every sink's queue (Chromium's IPC queue, a phone's
    // socket) bounded independently of producer cadence.
    on('screen', payload => this.screens.enqueue(payload))

    on('jsonl-entry', payload => {
      // Committed transcript state must not overtake an earlier cumulative semantic preview still
      // sitting in the 100 ms window. A client's own JSONL barrier can only flush messages it has
      // received, so main must establish this order before anything crosses a transport.
      this.semanticEvents.flush(payload.sessionId)
      this.enqueueJsonl(payload.sessionId, payload.entry, payload.file, payload.observation)
      // The fleet derives from the committed stream (sidecar dir from the file
      // path, done/error flips from Agent tool_results), so it sees every
      // entry as it arrives, not after the burst is batched.
      this.subAgents.observeParentEntry(payload.sessionId, payload.entry, payload.file)
    })
    on('jsonl-error', ({ sessionId, error }) => {
      // A failed drain can still commit earlier records. Preserve that order
      // across the asynchronous batch boundary or those records clear the
      // client's error after the durable channel has already stopped.
      this.flushJsonl(sessionId)
      this.emit('jsonl-error', {
        sessionId,
        // Errors do not survive structured clone or JSON; the message does.
        message: String(error.message ?? error),
      })
    })
    on('history-boundary', payload => {
      // Same ordering discipline as jsonl-error: a rewrite supersedes every
      // buffered record of the old generation, so both the 100 ms semantic
      // window and the pending jsonl batch must land BEFORE the boundary, and
      // the boundary itself crosses directly (never coalesced — it is an
      // ordering fact, not state to keep current).
      this.semanticEvents.flush(payload.sessionId)
      this.flushJsonl(payload.sessionId)
      this.emit('history-boundary', payload)
    })
    on('transcript-diagnostic', payload => this.emit('transcript-diagnostic', payload))
    on('provider-session-changed', payload => {
      // An ordering fact like history-boundary: rows of the OLD session still
      // buffered must land before the identity moves, so both windows flush
      // first and the change crosses directly.
      this.semanticEvents.flush(payload.sessionId)
      this.flushJsonl(payload.sessionId)
      this.emit('provider-session-changed', payload)
    })
    on('terminal-data', payload => this.emit('terminal-data', payload))
    // Shell activity (#865) crosses directly: the monitor already emits only on
    // change (at most once per terminal per second), so there is no burst for a
    // coalescer to absorb.
    on('terminal-foreground', payload => this.emit('terminal-foreground', payload))
    on('agent-pty-data', payload => this.emit('agent-pty-data', payload))
    on('process-state', payload => this.processStates.enqueue(payload))
    // Legacy per-condition channels (trust-dialog / resume-prompt /
    // permission-prompt) are deliberately NOT tapped. Clients consume only the
    // unified `conditions` snapshot and derive every pending-prompt field from
    // it; no renderer or harness ever subscribed to the granular channels
    // (confirmed by rg before removal — see
    // docs/audit-plans/execution/ipc-shared-contracts-implementation-log.md).
    // The manager STILL emits the granular events internally (provider
    // runtimes drive them); re-deprecating them is owned by the
    // conditions-framework cluster.
    on('conditions', payload => this.emit('conditions', payload))
    on('semantic-event', payload => this.semanticEvents.enqueue(payload))
    on('removed', payload => {
      // Final cleanup is keyed to removal, not exit. Some provider stop()
      // paths resolve without emitting exit, and SessionManager.kill() must
      // still be authoritative over the JSONL buffer and subagent watchers.
      // Natural exits emit `removed` before `exit`, so the final bulk JSONL
      // flush reaches every sink before the pane is marked exited — which is
      // why `exit` itself needs no flush of its own.
      // A structural session removal is an ordering barrier just like turn_completed. Flush every
      // pending cumulative delta before a client learns that a runtime disappeared; otherwise a
      // final assistant/tool prefix can be stranded behind teardown and never become visible.
      this.semanticEvents.flush(payload.sessionId)
      this.screens.flush(payload.sessionId)
      this.processStates.flush(payload.sessionId)
      this.flushJsonl(payload.sessionId)
      this.jsonlPending.delete(payload.sessionId)
      this.subAgents.stop(payload.sessionId)
      this.lastSubAgents.delete(payload.sessionId)
      this.emit('removed', payload)
      // The desktop pane still owns its display after a natural exit or
      // hibernation. Ending that claim here (even next tick) would discard
      // final observations held while an editor close sheet is open, or
      // revoke a successor recovery that reused the same id. Explicit pane
      // disposal releases its captured claim in session IPC; failed spawn
      // admission releases the id the caller never received. Window
      // ownership describes views, not live processes, so it is not the
      // tap's business at all.
    })
    on('exit', payload => {
      // A dead process owns no live fleet. RemoteServer's late-joiner cache
      // drops its copy on exit, so the tap's seed must too: otherwise a phone
      // that connects after the agent exited (pane still open) is primed with
      // the last fleet, members possibly still shown running (PR #1186
      // review). A fleet update the still-running watcher emits after this is
      // live truth and re-seeds normally.
      this.lastSubAgents.delete(payload.sessionId)
      this.emit('exit', payload)
    })
  }

  /**
   * Attach a sink. Sinks receive events in registration order; the returned
   * function detaches it. Detaching leaves the tap (and its manager
   * subscriptions and watchers) running for the other sinks — the tap's
   * lifetime is the manager's, not any one consumer's.
   */
  addSink(sink: SessionFeedSink, options: SessionFeedSinkOptions = {}): () => void {
    const registration: SinkRegistration = { sink, rawPty: options.rawPty === true }
    this.sinks.push(registration)
    return () => {
      const index = this.sinks.indexOf(registration)
      if (index >= 0) this.sinks.splice(index, 1)
    }
  }

  /** Latest sub-agent fleet for a session, for seeding a late-attaching
   *  sink. See lastSubAgents. */
  getSubAgentsSnapshot(sessionId: string): { sessionId: string; subAgents: Record<string, SubAgentState> } | null {
    return this.lastSubAgents.get(sessionId) ?? null
  }

  /**
   * Reseeding a late view is an ordering barrier. An older coalesced snapshot
   * must not flush AFTER the current cached snapshot a caller is about to
   * seed, so everything pending for the session crosses now.
   */
  flushSession(sessionId: string): void {
    this.semanticEvents.flush(sessionId)
    this.screens.flush(sessionId)
    this.processStates.flush(sessionId)
    this.flushJsonl(sessionId)
  }

  /**
   * Send a session's buffered committed rows NOW, ahead of whatever the
   * caller sends next on the same renderer channel (#1181). Narrower than
   * flushSession on purpose: the deliver-prompt reply only needs the prompt's
   * JSONL line to overtake it, and the snapshot coalescers have no part in
   * that ordering. An empty buffer is a no-op.
   */
  flushCommitted(sessionId: string): void {
    this.flushJsonl(sessionId)
  }

  flush(): void {
    this.semanticEvents.flush()
    this.screens.flush()
    this.processStates.flush()
    // WHY shutdown cannot rely on each session's eventual `removed`: killAll
    // and Electron teardown race the setImmediate used for ordinary
    // coalescing. Iterating the bounded session map preserves every
    // already-admitted commit before the app exits; the scheduled callbacks
    // later observe empty buffers and are harmless if the event loop remains
    // alive.
    for (const sessionId of [...this.jsonlPending.keys()]) this.flushJsonl(sessionId)
  }

  /** Unsubscribe from the manager and stop every watcher. Pending buffers
   *  are flushed first so nothing already admitted is silently lost. */
  dispose(): void {
    if (this.disposed) return
    this.flush()
    this.disposed = true
    for (const off of this.detach) off()
    this.detach.length = 0
    this.subAgents.stopAll()
    this.jsonlPending.clear()
    this.lastSubAgents.clear()
    this.sinks.length = 0
  }

  // JSONL burst coalescing.
  //
  // WHY: on a resumed Claude/Codex session, the headless `bootstrapTail`
  // parses the last ~200 lines from the JSONL file synchronously and emits
  // one `jsonl-entry` event per line. Forwarding each as its own message
  // produced ~200 round-trips per pane × N panes on restart — which on the
  // renderer side became 200N React renders, 200N O(N) spreads, and 200N
  // auto-scroll pins. That's the "feels like I'm being scrolled through the
  // whole conversation" bug.
  //
  // Coalescing: we buffer entries per sessionId, schedule ONE setImmediate
  // flush, and deliver the whole burst as a single `jsonl-entries` payload.
  // setImmediate (not Promise.resolve or process.nextTick) runs after the
  // current I/O tick finishes, so the whole bootstrapTail loop drains before
  // we schedule a send. Live mid-conversation entries land one per tick and
  // are flushed immediately after — no added latency for the streaming path.
  //
  // A singular `jsonl-entry` channel is intentionally NOT emitted: we used to
  // dual-emit (singular + coalesced) for "backward compatibility," but the
  // singular IPC queue beat the coalescer to the renderer on every burst and
  // the renderer's dedupe on the bulk path made it a no-op. Now everything
  // goes bulk; live single entries become 1-element bulk messages with ~1ms
  // latency from setImmediate — imperceptible.

  private enqueueJsonl(
    sessionId: string,
    entry: AgentTranscriptEntry,
    file: string,
    observation?: AgentTranscriptObservationMetadata,
  ): void {
    let pending = this.jsonlPending.get(sessionId)
    if (!pending) {
      pending = { entries: [], flushScheduled: false, intern: makeStringPool() }
      this.jsonlPending.set(sessionId, pending)
    }
    // #288: intern the duplicated metadata before buffering. Mutates the
    // entry in place; value-equality is preserved so every sink sees an
    // identical payload. The pool is the session's own (created above), so
    // first-seen-wins de-dup spans the whole session, not just one burst.
    internEntryFields(entry as Record<string, unknown>, pending.intern)
    // Preserve the wire shape for providers that do not publish rollout
    // observation metadata. An own `observation: undefined` property looks
    // harmless in memory, but it changes object-key inspection and structured
    // clone payloads for every Claude/OpenCode entry. Stage 0 is Codex-only; an
    // absent sidecar must remain genuinely absent outside that provider path.
    pending.entries.push({
      entry,
      file,
      ...(observation === undefined ? {} : { observation }),
    })
    if (!pending.flushScheduled) {
      pending.flushScheduled = true
      setImmediate(() => this.flushJsonl(sessionId))
    }
  }

  private flushJsonl(sessionId: string): void {
    const pending = this.jsonlPending.get(sessionId)
    if (!pending || pending.entries.length === 0) return
    const entries = pending.entries
    pending.entries = []
    pending.flushScheduled = false
    this.emit('jsonl-entries', { sessionId, entries })
  }

  private emit<P extends SessionFeedTapPayload>(channel: SessionFeedTapChannel, payload: P): void {
    if (this.disposed) return
    const raw = channel === 'terminal-data' || channel === 'agent-pty-data' || channel === 'terminal-foreground'
    let failure: { error: unknown } | null = null
    // Snapshot: a sink may detach itself (or another) while handling.
    for (const registration of [...this.sinks]) {
      if (raw && !registration.rawPty) continue
      // WHY one sink's throw must not reach the others: with two independent
      // EventEmitter subscribers a remote failure could never cost the
      // desktop a message delivered from a coalescer flush — the flush loops
      // belonged to the forwarder alone. Now a coalescer flush fans out to
      // every sink inside one loop, so an unguarded throw from the remote
      // sink would abort the loop and strand the desktop's remaining
      // sessions.
      try {
        registration.sink(channel, payload)
      } catch (error) {
        failure ??= { error }
      }
    }
    // Re-raised SYNCHRONOUSLY, after every sink has had the event, so the
    // failure lands exactly where a throwing listener's always did: back in
    // SessionManager.emit's caller for a direct event (a spawn path's own
    // error handling sees it), and in the timer callback for a coalescer
    // flush. A first version re-raised on a microtask, which turned every
    // sink bug into an uncaughtException — and main's crash hooks exit the
    // process on those (PR #1186 review). Only the FIRST failure is raised;
    // a second sink failing on the same event is the same incident.
    if (failure) throw failure.error
  }
}
