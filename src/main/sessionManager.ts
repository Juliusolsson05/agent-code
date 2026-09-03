import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import path from 'node:path'
import { performance } from 'perf_hooks'

import { getMainProvider } from '@providers/registry.main.js'
import { resolveProviderTranscriptPath } from '@main/providerSwitch/shared.js'
import { TerminalSession } from '@shared/runtime/terminalSession.js'
import { pickShell } from '@shared/runtime/pickShell.js'
// WHY the manager no longer imports ScreenSnapshot from
// @providers/claude/runtime/claudeSession or JsonlEntry from
// claude-code-headless: those Claude-provider imports inverted the
// dependency arrow — the manager (provider-neutral by contract) knew
// Claude's types by name and dragged them into every downstream
// consumer's type graph. Phase 2a moves the wire shapes to
// @shared/types/session.ts as neutral homes (AgentScreenSnapshot /
// AgentTranscriptEntry). Same runtime payloads, no import arrow into
// a provider. See #394 phase 2a.
import type {
  AgentSession,
  AgentScreenSnapshot,
  AgentTranscriptEntry,
  AgentTrustDialogState,
  AgentResumePromptState,
  AgentPermissionPromptState,
  AgentProcessState,
  AgentTranscriptObservationMetadata,
  AgentInputReadiness,
  SessionBackendSnapshot,
  SessionInputReadiness,
  SessionOwnershipOptions,
  SessionRecoveryCancellationOptions,
  SessionRecoverOptions,
  SessionRecoverResult,
} from '@shared/types/session.js'
import { TmuxRegistry } from '@main/tmux/TmuxRegistry.js'
import { performanceService } from '@main/performance/PerformanceService.js'
import { getToolPath, refreshToolchainFromState } from '@main/setup/toolchain.js'
import { resolveToolPath } from '@main/setup/binaryResolver.js'
import { updateToolPaths } from '@main/setup/setupState.js'
import { forgetFeedDebugSession } from '@main/storage/feedDebugLog.js'
import { CappedTextBuffer } from '@main/sessions/cappedTextBuffer.js'
import type {
  ConditionCustomAction,
  ProviderConditionSnapshot,
} from '@shared/types/providerConditions.js'
import {
  DEFAULT_PROVIDER,
  isAgentProviderKind,
  isSessionKind,
} from '@shared/types/providerKind.js'
import type { AgentProviderKind, SessionKind } from '@shared/types/providerKind.js'
import type { BuiltInMcpDomain, BuiltInMcpServerConfig } from '@mcp/shared/types.js'
import type { BuiltInMcpHttpHost } from '@mcp/runtime/BuiltInMcpHttpHost.js'
import type { AppRunJournal } from '@main/incident/AppRunJournal.js'
import { SessionLifecycleJournal } from '@main/lifecycle/SessionLifecycleJournal.js'
import type { PromptGateState } from '@shared/types/session.js'
import {
  isCodexTranscriptObservationEventName,
  isCodexTranscriptObservationSessionId,
  pickCodexTranscriptObservationCorrelationIds,
  pickCodexTranscriptObservationData,
  pickLifecycleCorrelationIds,
  type CodexTranscriptObservation,
  type CodexTranscriptObservationEventName,
  type SessionLifecycleCorrelationIds,
  type SessionLifecycleData,
} from '@shared/lifecycle/events.js'
import type {
  SessionSpawnOptions,
  SessionSpawnResult,
} from '@preload/api/types.js'
import type { PromptDeliveryResult } from '@shared/types/providerConfig.js'
import {
  CodexReplacementLedger,
  type CodexReplacementReclaim,
  type CodexReplacementRedirect,
  type CodexReplacementReservation,
} from '@main/sessions/codexReplacementLedger.js'

function codexObservationEnumOrUnknown(
  name: CodexTranscriptObservationEventName,
  key: string,
  value: unknown,
): string {
  if (typeof value !== 'string') return 'unknown'
  // The shared sanitizer is the vocabulary authority. Reusing it here avoids a
  // second hand-maintained enum while preserving a crucial distinction at the
  // provider boundary: a present future value is evidence of schema drift and
  // must degrade to the explicit `unknown` sentinel, not disappear as though
  // the producer omitted the field altogether.
  const picked = pickCodexTranscriptObservationData(name, { [key]: value })
  return (picked as Record<string, unknown> | undefined)?.[key] === value
    ? value
    : 'unknown'
}

// SessionManager: a thin registry on top of ClaudeSession / TerminalSession
// that lets the main process run N sessions in parallel. Every event
// every session emits is re-emitted here with the sessionId attached,
// so the Electron IPC forwarder can attach one listener per channel
// instead of N×channels.
//
// Why not just use a plain Map<id, ClaudeSession> and attach listeners
// directly from main/index.ts:
//   - main/index.ts would need to re-subscribe every time a session is
//     spawned, and unsubscribe on kill, doubling the bookkeeping.
//   - The forwarder would have to multiplex events from N sessions into
//     one IPC channel per event type anyway — the mux belongs here where
//     it's testable in isolation.
//
// Multi-kind support: Agent Code can host two kinds of sessions per pane
// today — a Claude Code session (ClaudeSession) or a plain shell
// terminal (TerminalSession). The registry holds a union; spawn()
// dispatches on options.kind; events from both are funnelled through
// the same ManagerEvents map with a 'kind' tag on each payload so the
// IPC forwarder can emit them on kind-specific channels if it wants
// (today the renderer just checks the kind on its side).

// SessionKind is the shared provider/session-kind source of truth
// (@shared/types/providerKind). Re-exported here because MCP runtime
// imports `SessionKind` from `@main/sessionManager`; keeping the
// re-export preserves that import path while removing the duplicate
// inline union that used to drift from preload/renderer copies.
export type { SessionKind } from '@shared/types/providerKind.js'

// WHY private: this is the EventEmitter event map for SessionManager.
// It's used internally to type `on()`/`off()`/`emit()` overloads (see
// the `SessionManager` interface below), but no external file imports
// the bare type. Keeping it module-private documents the API surface:
// callers consume the manager through the `SessionManager` interface,
// not via direct event-map type access.
type ManagerEvents = {
  // Optional at the event type seam for older recordings and test/remote feed
  // implementations; every real SessionManager spawn emits it below.
  started: [{ sessionId: string; sessionRunId?: string; kind: SessionKind; projectDir?: string }]
  'input-readiness': [{ sessionId: string; input: SessionInputReadiness }]
  'pty-data': [{ sessionId: string; data: string }]
  /** Raw PTY bytes for an attached agent inline terminal. Emitted
   *  only after attachAgentPty() flips the per-session attach flag. */
  'agent-pty-data': [{ sessionId: string; data: string }]
  /** Scraped TUI snapshot from a PTY-backed provider. Claude and
   *  Codex both fire this; a future API-only provider (opencode) won't. */
  screen: [{ sessionId: string } & AgentScreenSnapshot]
  /** Parsed transcript entry from a JSONL/rollout-backed provider.
   *  Payload shape is provider-defined (`Record<string, unknown>` at
   *  this seam); the renderer narrows by shape. See the transcript-
   *  entry-codec plan in #394 phase 2b — this seam is what promotes
   *  it onto the registry. */
  'jsonl-entry': [{
    sessionId: string
    entry: AgentTranscriptEntry
    file: string
    observation?: AgentTranscriptObservationMetadata
  }]
  'jsonl-error': [{ sessionId: string; error: Error }]
  'transcript-diagnostic': [{ sessionId: string; diagnostic: unknown }]
  'process-state': [{ sessionId: string; active: boolean; status?: string }]
  'trust-dialog': [{ sessionId: string; visible: boolean; workspace?: string }]
  'resume-prompt': [{
    sessionId: string
    visible: boolean
    sessionAgeText?: string
    tokenCountText?: string
    options?: string[]
    selectedIndex?: number
  }]
  'permission-prompt': [{
    sessionId: string
    visible: boolean
    title?: string
    toolName?: string
    command?: string
    options?: Array<{ key: string; label: string }>
    selectedIndex?: number
  }]
  conditions: [{ sessionId: string; snapshot: ProviderConditionSnapshot }]
  /** Emitted only by terminal sessions — raw PTY output for xterm.js. */
  'terminal-data': [{ sessionId: string; data: string }]
  /** Emitted by agent providers that expose a semantic stream — currently
   *  BOTH Claude and Codex (this comment used to say "only by Claude", which is
   *  stale: CodexSession forwards semantic events too, see codexSession's
   *  'semantic-event' forwarding). Per-block stream, proxy-driven for Claude
   *  (or screen-fallback turn-level deltas without `useProxy`) and rollout/proxy
   *  derived for Codex. Payload is a provider discriminated union — see
   *  EVENT_SPEC.md. Forwarded as `unknown` at this layer ON PURPOSE: the manager
   *  is provider-agnostic and must NOT couple to one provider's schema; the
   *  renderer narrows by `ev.type`. */
  'semantic-event': [{ sessionId: string; event: unknown }]
  /** Internal cleanup signal emitted exactly before a session leaves the manager. */
  removed: [{ sessionId: string }]
  exit: [{ sessionId: string; exitCode: number; signal?: number }]
}

// A same-cwd burst can expose many ownership candidates. Stage 0 needs the
// individual fingerprints to reconstruct the ambiguity graph, but the always-on app
// journal has a deliberately bounded pending queue. Matching candidates go
// first below, and this hard ceiling keeps one pathological scan from evicting
// the sparse submit/reconcile evidence needed to explain the user-visible bug.
const MAX_CODEX_CANDIDATE_OBSERVATIONS_PER_RUN = 8
const MAX_CODEX_CANDIDATE_EDGE_KEYS_PER_RUN = 256
const MAX_CODEX_ATTACHMENT_TRANSITIONS_PER_RUN = 8

type PtySize = { cols: number; rows: number }

export interface SessionManager {
  on<K extends keyof ManagerEvents>(
    event: K,
    listener: (...args: ManagerEvents[K]) => void,
  ): this
  off<K extends keyof ManagerEvents>(
    event: K,
    listener: (...args: ManagerEvents[K]) => void,
  ): this
  emit<K extends keyof ManagerEvents>(
    event: K,
    ...args: ManagerEvents[K]
  ): boolean
}

// The provider session contract now lives at @shared/types/session.ts
// as `AgentSession` (with a typed event map + strictly typed
// on/off/emit interface). The manager just references it; each
// provider runtime DECLARES conformance where it's defined, so a
// missing event/method surfaces as a compile error in the provider,
// not silently at runtime here.
//
// Historical shape kept in the git log: this was `AgentSessionLike`, a
// duck-type with `on(event: string, listener: (...args: never[]) => void)`
// — permissive to the point of enforcing nothing. See #394 phase 2a
// for the migration rationale.
//
// Local aliases used below just narrow AgentSession for the
// duck-typed-optional-method call sites (awaitPastePlaceholder,
// awaitReadyForPrompt), so the callers keep reading naturally.
type AgentSessionLike = AgentSession

type RegistryLifecycle = {
  /**
   * Identifies this concrete main-owned backend lifetime, not the durable pane.
   *
   * WHY `sessionId` is insufficient: recovery and provider replacement can
   * reuse the pane id while replacing the process underneath it. Transcript
   * observations from those two lifetimes must never join merely because the
   * renderer still calls both of them the same pane.
   */
  runId: string
  generation: symbol
  startSettled: boolean
  naturalExitObserved: boolean
  stopRequested: boolean
  stopRequestedBeforeStartSettled: boolean
  stopPromise: Promise<void> | null
  postStartStopPromise: Promise<void> | null
}

export type CodexSessionRunState = 'live' | 'retired'

type RecentCodexSessionRun = {
  sessionId: string
  sessionRunId: string
  state: CodexSessionRunState
}

// The ledger exists only to bridge short renderer/main teardown races. Keeping
// thousands of exact run pairs covers far more than one app window can have in
// flight while still making memory use independent of total historical agent
// count. This is not transcript history and must never grow with disk history.
const RECENT_CODEX_SESSION_RUN_LIMIT = 2_048

// Internal registry shape: we store the concrete instance plus its
// kind so kill/write/resize can dispatch without sniffing the object.
// The registry holds concrete session instances. Agent sessions
// (claude, codex) are created via the provider registry; terminal
// sessions are handled directly.
type RegistryEntry =
  | {
      kind: AgentProviderKind
      session: AgentSessionLike
      lifecycle: RegistryLifecycle
    }
  | {
      kind: 'terminal'
      session: TerminalSession
      tmuxName: string | null
      lifecycle: RegistryLifecycle
    }

type RecoveryClaim = {
  kind: SessionKind
  cwd: string
  recoveryTokens: Set<string>
  startedAt: number
  cancelled: boolean
  spawnGeneration: symbol | null
  promise: Promise<SessionRecoverResult>
}

type CodexReplacementReservationRecord =
  CodexReplacementReservation<RecoveryClaim>

type SessionSpawnInfo = {
  kind: SessionKind
  cwd: string
  resumeSessionId: string | null
  dangerousMode: boolean
  useProxy: boolean
}

type CodexReplacementProof = 'same-resume-id' | 'same-transcript-path'

type CodexReplacementHandoff = {
  reservation: CodexReplacementReservationRecord
  predecessorSessionId: string
  predecessorOwnership: SessionOwnershipOptions
  predecessorEntry: RegistryEntry
  predecessorRecovery: RecoveryClaim | null
  proof: CodexReplacementProof
  restoreOptions: SessionSpawnOptions
  stopPromise: Promise<void> | null
  compensationRequired: boolean
}

class RecoveryCancelledError extends Error {
  constructor() {
    super('Session recovery was cancelled')
    this.name = 'RecoveryCancelledError'
  }
}

function createRegistryLifecycle(generation: symbol): RegistryLifecycle {
  return {
    runId: randomUUID(),
    generation,
    startSettled: false,
    naturalExitObserved: false,
    stopRequested: false,
    stopRequestedBeforeStartSettled: false,
    stopPromise: null,
    postStartStopPromise: null,
  }
}

// Rolling buffer cap for terminal replay. 256 KB is enough to hold
// the recent scrollback of a normal interactive shell session —
// well beyond "the shell prompt and a few commands ago" which is
// the actual requirement. Past the cap we keep the tail (newest
// content wins) so long-running shells don't blow up memory.
// One event per session per second for composer writes. A raw terminal view
// emits one write per keystroke, so this is the difference between a journal
// that answers "who typed here" and one that is nothing but keystrokes.
const INPUT_WRITE_COALESCE_MS = 1000

/**
 * Who put bytes into a session's PTY.
 *
 * Every value here is derived from information the write boundary ALREADY has,
 * which is why the split costs nothing: `remote` is a distinct manager entry
 * point, and `renderer-paste` is just the existing optional `pasteId` on
 * `session:input` read as the attribution signal it already is.
 *
 * `renderer` stays a bucket, and the honest reading is "an app surface that is
 * not a paste" — the raw terminal view, terminal panes, dictation, the debug
 * terminal, and our own Clear command are indistinguishable from each other.
 * Separating them needs an origin threaded from each call site through the
 * shared SessionFeed contract, and that is deliberately NOT done here: it is a
 * contract change worth making only if Stage 2 shows a renderer writer is
 * implicated at all. Today the evidence points the other way — 52 of 57
 * recorded refusals had no orphaned write of any kind — so the useful question
 * is whether ANY writer touched the composer, and that this union answers.
 */
type InputWriteOrigin =
  | 'delivery'
  | 'condition'
  | 'remote'
  | 'renderer-paste'
  | 'renderer'

const TERMINAL_BUFFER_CAP = 256 * 1024

// Raw-agent terminal buffer cap. This is intentionally larger than the
// plain terminal cap because Claude/Codex TUIs emit more repaint bytes
// than a normal shell: full-screen redraws, ANSI cursor movement, and
// progress rows can churn heavily even when the visible content is
// small. We still cap aggressively because this buffer is debug-only
// replay state, not the durable transcript source of truth.
const AGENT_PTY_BUFFER_CAP = 512 * 1024

export type ResolveConditionResult =
  | { ok: true; state?: unknown }
  | {
      ok: false
      reason:
        | 'timeout'
        | 'aborted'
        | 'invalid-payload'
        | 'option-not-found'
        | 'no-session'
        | 'no-headless'
        | 'no-resolver'
      lastState?: unknown
      failedAtStep?: string
    }

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, RegistryEntry>()
  private readonly spawningSessionGenerations = new Map<string, symbol>()
  private readonly sessionStateGenerations = new Map<string, symbol>()
  // WHY this is separate from spawningSessionGenerations: the map is a low-level
  // duplicate-spawn guard, while this map is the public reconciliation
  // authority. A renderer reload, a wake action, and a remote caller may all
  // ask for the same persisted pane concurrently. They must join the same
  // result rather than interpreting an ordinary in-flight recovery as an
  // error. The claim is installed synchronously before provider/MCP code can
  // re-enter main and is always released by the owning recovery's finally.
  private readonly recoveriesInFlight = new Map<string, RecoveryClaim>()
  // WHY main owns this reservation: renderer guards disappear on reload and
  // remote/MCP callers never share renderer state. PTY prompt delivery is a
  // per-session critical section; without it, Enter from attempt A can submit
  // paste B and turn a slow operation into duplicate queue entries.
  private readonly promptDeliveriesInFlight = new Set<string>()
  /**
   * Open coalescing window per session for `input.write`. See recordInputWrite.
   *
   * The timer handle is held so teardown can cancel it. Without that, a session
   * that dies mid-window leaves a timer that fires against a session id the
   * registry no longer knows, and the map entry itself outlives the session —
   * the exact per-session-map leak class `cleanupSessionState` exists to stop.
   */
  private readonly inputWriteCoalesce = new Map<string, {
    firstAt: number
    writes: number
    bytes: number
    origin: InputWriteOrigin
    hadSubmit: boolean
    timer?: ReturnType<typeof setTimeout>
  }>()
  private readonly lastActivityAt = new Map<string, number>()
  // Latest per-session UI-state snapshots, cached at the emit sites below.
  // WHY: consumers that attach mid-flight (the remote mobile companion's
  // SessionFeedSource/RemoteServer — enabled long after sessions started —
  // and any future late subscriber) would otherwise see nothing until the
  // NEXT event: an idle agent redraws no screen, and a condition snapshot
  // only re-emits on change, so a pending permission prompt raised before
  // the subscriber existed would be invisible forever. Cost is one Map.set
  // per event (a reference store, no clone); entries die with the session
  // in cleanupSessionState.
  private readonly lastScreenSnapshot = new Map<string, AgentScreenSnapshot>()
  private readonly lastConditionsSnapshot = new Map<string, ProviderConditionSnapshot>()
  private readonly lastInputReadiness = new Map<string, SessionInputReadiness>()
  // WHY this is one manager-global sequence instead of a bounded per-id map:
  // a persisted pane may reuse its stable local id after arbitrarily many
  // unrelated sessions have come and gone. Evicting that id's watermark made
  // the replacement restart at revision 1 while a renderer still held N, so
  // every truthful ready/unready event looked stale. One scalar is both more
  // memory-efficient and strictly orders every readiness fact produced during
  // this main-process lifetime; renderer state from any older generation can
  // never outrank a replacement.
  private inputReadinessRevision = 0
  // Durable transcript path per session, cached from the jsonl-entry relay.
  // This is the one main-side key that unlocks history reads for a LIVE
  // session: cwd is provider-constructor-private and the provider session id
  // exists only inside the jsonl lines, but every entry event carries the
  // file it was appended to. Consumed by the remote companion's get-history
  // (see main/remote/RemoteServer.ts); same lifetime as the snapshot caches.
  //
  // KNOWN STALENESS WINDOW: when the provider rolls to a new transcript
  // (claude /clear, or a resume that mints a new provider session id → new
  // jsonl path), this cache points at the PREVIOUS conversation's file until
  // the new conversation writes its first durable line. Main has no earlier
  // roll signal than that first entry. Consumers must therefore treat the
  // served file as advisory: RemoteServer returns the file identity with
  // every history chunk, and the phone's TranscriptStore discards a chunk
  // whose file disagrees with the file its live frames carry.
  private readonly lastTranscriptFile = new Map<string, string>()
  private readonly codexCandidateObservationEdges = new Map<
    string,
    {
      sessionRunId: string
      seenKeys: Set<string>
      emittedKeys: Set<string>
      emittedCount: number
      trackingCapped: boolean
    }
  >()
  private readonly codexAttachmentObservationState = new Map<
    string,
    {
      sessionRunId: string
      lastTransitionKey: string | null
      emittedTransitions: number
      capReported: boolean
    }
  >()
  // WHY a separate exact-pair ledger exists beside `sessions`: renderer
  // post-commit effects can report after the provider exit synchronously
  // removes the live registry entry. Treating every absent sessionId as a
  // retired Codex run lets arbitrary renderer strings masquerade as ownership
  // evidence (and reach debug bundles). This bounded main-authored ledger is
  // the only proof that an absent `{sessionId, sessionRunId}` pair ever existed.
  private readonly recentCodexSessionRuns = new Map<string, RecentCodexSessionRun>()
  // Spawn-time identity captured for LATE resolution. The transcript-file
  // cache above starts empty every app run, but RESUMED sessions have a
  // durable transcript on disk from the moment they spawn — main just needs
  // {cwd, resumeSessionId} to re-derive its path via the provider resolver.
  // Without this, the remote companion's history backfill returned nothing
  // for every restored session until it wrote a NEW line (field bug: "still
  // just dumping the raw terminal" after an app restart). cwd doubles as
  // the human-readable workspace label for the remote session list — the
  // 'started' event's projectDir is the TRANSCRIPT directory for Claude,
  // not the workspace the user thinks of.
  private readonly spawnInfo = new Map<
    string,
    SessionSpawnInfo
  >()
  // One same-pane Codex replacement per predecessor at a time. The exact
  // rollout coordinator catches a second physical tail, but that is too late:
  // provider construction, readiness publication, and proxy setup have already
  // happened by then. This app-level claim rejects a duplicate user gesture at
  // the boundary that actually knows which local pane authorized the handoff.
  // One ledger owns every replacement identity and lifetime transition. Main
  // still executes the provider work, but no call site may maintain a partial
  // predecessor-only view of a lineage whose close/recover can arrive by the
  // successor ID. See codexReplacementLedger.ts for the isolation rationale.
  private readonly codexReplacements = new CodexReplacementLedger<RecoveryClaim>()
  // killAll is terminal for a SessionManager instance. Without an admission
  // fence, a recovery IPC already queued behind teardown could publish a fresh
  // claim after the shutdown snapshots below and resurrect a provider.
  private shuttingDown = false
  private readonly sessionSizes = new Map<string, PtySize>()
  // Coalesce "input write to a session main doesn't own" incidents — the
  // restored-agents-null bug can make a renderer spam writes against a stale id,
  // so we journal the FIRST miss per session id and then stay quiet.
  private readonly inputWriteFailedReported = new Set<string>()
  // Every session id main has EVER owned (bounded FIFO). Used to tell the
  // restored-agents-null bug (a write to an id we never owned) apart from the
  // benign, documented race (a late write arriving after a session we DID own
  // exited). Only the former is a real incident — without this, normal agent
  // teardown with an in-flight keystroke would cry wolf with an error incident.
  private readonly everKnownSessionIds = new Set<string>()

  // Optional tmux backing for terminal sessions. Constructed by the
  // app entrypoint AFTER detectAvailability() has resolved — we only
  // accept a registry that is known to be usable, so a non-null value
  // here means tmux IS installed. When null, terminal sessions fall
  // back to direct PTY spawn (no persistence).
  constructor(
    private readonly tmuxRegistry: TmuxRegistry | null = null,
    private readonly builtInMcpHost: BuiltInMcpHttpHost | null = null,
    // Always-on incident journal. Optional so tests / non-journaled callers
    // still construct cleanly; null-guarded at every use.
    private readonly journal: AppRunJournal | null = null,
    private readonly beforeAgentSessionStart: (() => Promise<void>) | null = null,
    // Optional opt-in recording projection. Kept as a structural callback so
    // the process/session registry does not depend on the dev-debug recorder.
    private readonly recordCodexObservation: (
      sessionId: string,
      sessionRunId: string,
      observation: CodexTranscriptObservation,
    ) => void = () => {},
  ) {
    super()
    // Typed lifecycle emitter over the same journal. Constructed here rather
    // than injected so every SessionManager — including the ones tests build
    // with a null journal — has a non-null emitter and no call site needs a
    // `?.` guard. See SessionLifecycleJournal for why nothing may READ these.
    this.lifecycle = new SessionLifecycleJournal(journal)
  }

  private readonly lifecycle: SessionLifecycleJournal

  // Terminal attach/replay state.
  //
  // Why: when the renderer opens a new terminal pane, the sequence
  // is (1) spawn the session on the main side, (2) IPC invoke
  // resolves with sessionId, (3) renderer re-renders, (4)
  // TerminalLeaf mounts, (5) useEffect runs and subscribes to
  // 'session:terminal-data'. Between steps 1 and 5 the shell has
  // already started, sourced its rc files, and printed its prompt —
  // all of which fires as 'data' events on the TerminalSession that
  // reach main before any subscriber exists. Without buffering
  // those events are dropped, and the user sees an empty xterm
  // with a blinking cursor: the shell is waiting for input but
  // there's nothing on screen.
  //
  // Fix is two-part:
  //   - Buffer every byte of PTY output per session in
  //     `terminalBuffers`. Subject to TERMINAL_BUFFER_CAP.
  //   - Only broadcast 'terminal-data' events to the renderer
  //     AFTER the renderer has called attachTerminal(sessionId),
  //     which atomically returns the current buffer AND flips
  //     the attached flag. Before attach, data accumulates in the
  //     buffer silently.
  //
  // The atomic grab-and-attach is critical: if we broadcast while
  // the buffer was still accumulating, the renderer would receive
  // duplicate bytes (once in the buffer, once as a live event).
  // Toggling the flag in the same synchronous tick as the buffer
  // read means no data can slip through between the two.
  // WHY CappedTextBuffer and not a string: see src/main/sessions/
  // cappedTextBuffer.ts — the string version copied the whole cap on every
  // chunk and retained sliced-string parents (#726).
  private readonly terminalBuffers = new Map<string, CappedTextBuffer>()
  private readonly terminalAttached = new Set<string>()

  // Agent PTY terminal replay state. Agent sessions already publish
  // parsed screen snapshots to the renderer, which is perfect for the
  // structured feed but not enough for a real inline terminal: xterm
  // needs the raw byte stream, including ANSI cursor movement and full
  // repaint sequences. We therefore keep a capped byte-string replay
  // buffer per Claude/Codex session and expose it only when a raw terminal
  // consumer explicitly attaches (DebugPanel or #247's pane-level terminal
  // mode).
  //
  // This deliberately uses the same attach/replay contract as
  // TerminalLeaf instead of forwarding every agent byte to the
  // renderer from process start: most users never open the raw inline
  // terminal, and agent PTYs can be noisy. Buffer in main, broadcast
  // only after an attach, and let the renderer replay the buffer before
  // draining live bytes.
  private readonly agentPtyBuffers = new Map<string, CappedTextBuffer>()
  private readonly agentPtyAttachCounts = new Map<string, number>()
  private readonly agentPtyRestoreSizes = new Map<string, PtySize>()

  private markActivity(sessionId: string): void {
    this.lastActivityAt.set(sessionId, Date.now())
  }

  /**
   * Last gate verdict observed per session, plus when this stretch of it began.
   *
   * Exists so a STALL has a duration. A single "not ready, composer-unpainted"
   * event is nearly worthless — that is the normal state for a moment during
   * every boot. The same verdict still holding ninety seconds later is the
   * whole bug, and nothing in the app records elapsed time in a gate state.
   */
  private readonly lastGateEvaluation = new Map<
    string,
    { signature: string; gate: string; kind: SessionKind; reason: string | null; since: number; samples: number }
  >()

  private gateSampler: ReturnType<typeof setInterval> | null = null

  private noteGateEvaluation(sessionId: string, kind: SessionKind, gate: PromptGateState): void {
    const reason = 'reason' in gate ? gate.reason : null
    const conditionKind = gate.kind === 'blocked' ? gate.condition : null
    // WHY the signature includes the condition and not just kind+reason:
    //
    // `blocked` states carry NO `reason` field — they carry `condition` and
    // `resolvable`. Comparing only kind+reason therefore made every blocked
    // state look identical, so a transition from blocked/trust-dialog to
    // blocked/permission-prompt was silently dropped AND its `since` never
    // reset. That is the one event whose stated purpose is recording what a
    // gate is blocked on, so dropping a change of what it is blocked on
    // defeated it entirely.
    const signature = `${gate.kind}:${reason ?? ''}:${conditionKind ?? ''}`
    const previous = this.lastGateEvaluation.get(sessionId)
    const changed = previous === undefined || previous.signature !== signature
    const since = changed ? Date.now() : previous.since
    this.lastGateEvaluation.set(sessionId, {
      signature,
      gate: gate.kind,
      kind,
      reason,
      since,
      samples: changed ? 0 : (previous?.samples ?? 0),
    })
    // The upstream `publishPromptGate` already returns early on an unchanged
    // verdict, so this is not the load-bearing deduplication — it exists so
    // `since` stays anchored to when the CURRENT state began, and so a future
    // provider that emits unconditionally cannot flood the journal.
    if (!changed) return
    this.lifecycle.session('gate.eval', sessionId, {
      kind,
      gate: gate.kind,
      reason,
      ...(gate.kind === 'blocked'
        ? { conditionKind: gate.condition, resolvable: gate.resolvable }
        : {}),
      elapsedMs: 0,
    })
    this.ensureGateSampler()
  }

  /**
   * Re-record any session that has been sitting in a non-ready gate, once every
   * SAMPLE seconds.
   *
   * WHY sampling at all, given `prompt-gate` is already edge-triggered at the
   * source: a transition tells you a stall STARTED and nothing tells you it is
   * still going. Without re-sampling, a session wedged for ten minutes and one
   * wedged for two seconds produce byte-identical journals — and the duration
   * is the entire diagnostic. Periodic sampling answers "stuck at X for 90s"
   * in a few hundred bytes; emitting unconditionally from the screen-snapshot
   * path would cost megabytes and evict the breadcrumbs around it.
   *
   * WHY it only runs while something is non-ready: an idle workspace of ready
   * agents writes nothing at all.
   *
   * TWO BOUNDS, both learned in review, both protecting the SAME shared budget:
   *
   * 1. **States that mean "waiting on a human" are not sampled.** `occupied`
   *    (a draft in the composer) and `blocked` (a trust or permission prompt on
   *    screen) are the app working correctly and waiting for the user. A pane
   *    parked on an unanswered trust dialog would otherwise emit 17,280 events
   *    a day describing a non-problem.
   * 2. **Sampling stops after MAX_SAMPLES per stall stretch.** The signal
   *    saturates: knowing a gate has been stuck for two minutes proves the
   *    stall; the 300th identical sample proves nothing more.
   *
   * Why both matter more than they look: `AppRunJournal.reserveJournalBytes` is
   * a PERMANENT latch. Once a run hits the 50 MiB ceiling, every later event
   * AND incident is dropped for the rest of that run — heap pressure,
   * window-unresponsive, crash breadcrumbs included. An unbounded sampler could
   * therefore blind the incident journal over a multi-day run, which is exactly
   * the outcome this instrumentation exists to prevent.
   */
  private ensureGateSampler(): void {
    if (this.gateSampler) return
    const SAMPLE_MS = 5_000
    // ~2 minutes of stall at 5s. Past that the fact is established.
    const MAX_SAMPLES = 24
    // Gate kinds that mean "correctly waiting for the user", not "stalled".
    const AWAITING_HUMAN = new Set(['occupied', 'blocked'])
    this.gateSampler = setInterval(() => {
      let stalled = 0
      for (const [sessionId, state] of this.lastGateEvaluation) {
        if (state.gate === 'ready') continue
        if (AWAITING_HUMAN.has(state.gate)) continue
        if (!this.sessions.has(sessionId)) continue
        if (state.samples >= MAX_SAMPLES) continue
        stalled += 1
        state.samples += 1
        this.lifecycle.session('gate.eval', sessionId, {
          // `kind` was missing here, so every SAMPLE dropped out of
          // provider-filtered queries while the transitions stayed in.
          kind: state.kind,
          gate: state.gate,
          reason: state.reason,
          elapsedMs: Date.now() - state.since,
        })
      }
      if (stalled === 0 && this.gateSampler) {
        clearInterval(this.gateSampler)
        this.gateSampler = null
      }
    }, SAMPLE_MS)
    // Never hold the process open for a diagnostic timer.
    this.gateSampler.unref?.()
  }

  private setInputReadiness(sessionId: string, next: AgentInputReadiness): void {
    const previous = this.lastInputReadiness.get(sessionId)
    if (previous?.ready === next.ready && previous.reason === next.reason) return
    const revision = ++this.inputReadinessRevision
    const input: SessionInputReadiness = {
      ...next,
      revision,
    }
    this.lastInputReadiness.set(sessionId, input)
    // WHY readiness is emitted as a level fact with a main-owned revision:
    // providers know the real composer boundary, but renderer reload can race
    // both the provider event and the recovery snapshot. A monotonic counter
    // lets every consumer subscribe first, seed second, and reject an older
    // seed that arrives after a newer event. Process/activity signals cannot
    // safely substitute for this fact.
    this.emit('input-readiness', { sessionId, input })
    // Records only the DEDUPED transitions this method actually publishes —
    // deliberately not every provider evaluation. The per-evaluation stream is
    // `gate.eval`, emitted at the provider, and the two together are what make
    // a stall legible: `gate.eval` says the provider keeps re-deciding
    // "not ready, composer-unpainted", while the absence of a following
    // `readiness.publish` proves no consumer was ever told anything changed.
    // That gap is invisible today and is the shape behind "the agent takes
    // minutes to start".
    this.lifecycle.session('readiness.publish', sessionId, {
      ready: input.ready,
      reason: input.reason ?? null,
      revision,
    })
  }

  private cleanupSessionState(
    sessionId: string,
    kind: SessionKind,
    expectedEntry?: RegistryEntry,
    revokeAgentMcp = kind !== 'terminal',
    expectedGeneration = expectedEntry?.lifecycle.generation,
  ): boolean {
    // WHY this helper exists even before the larger SessionState consolidation:
    // per-session state currently lives in several maps whose lifetimes must end
    // together. Keeping all deletes here makes the removal invariant visible and
    // prevents the exact leak class this file had: a new per-session map being
    // added to spawn paths but forgotten in one teardown branch. External
    // resources (JSONL coalescer buffers and subagent watchers) are cleaned by
    // the separate `removed` event so SessionManager does not import forwarder
    // internals.
    // WHY cleanup is generation-owned: stable local ids are deliberately
    // reused after a failed provider start. The old wrapper may still emit a
    // late exit/readiness event after its replacement is registered. An
    // id-only delete would let generation A revoke generation B's MCP token
    // and erase B from the registry. Every entry-backed teardown therefore
    // proves it still owns the exact object installed under this id.
    if (expectedEntry && this.sessions.get(sessionId) !== expectedEntry) return false
    if (
      expectedGeneration &&
      this.sessionStateGenerations.get(sessionId) !== expectedGeneration
    ) {
      return false
    }
    const retiringEntry = expectedEntry ?? this.sessions.get(sessionId)
    if (kind === 'codex' && retiringEntry?.kind === 'codex') {
      // Record retirement before deleting the authoritative row. A synchronous
      // renderer report cannot interleave inside this call, but downstream
      // `removed` handlers and later IPC turns need the exact former run after
      // registry visibility has ended.
      this.rememberCodexSessionRun(
        sessionId,
        retiringEntry.lifecycle.runId,
        'retired',
      )
    }
    this.sessions.delete(sessionId)
    this.sessionStateGenerations.delete(sessionId)
    // Flush rather than drop: the writes in an open window really happened, and
    // the ones immediately before a session dies are the most diagnostically
    // valuable of all — a delivery that was mid-flight when the PTY exited is
    // exactly the shape being investigated. flushInputWrite also clears the
    // pending timer, so this both emits the record and ends the map entry's
    // lifetime with the session.
    this.flushInputWrite(sessionId)
    // UI-state snapshot caches die with the session — replaying a dead
    // session's screen/conditions to a late subscriber would present it as
    // live (the exact stale-state bug the remote late-joiner replay had).
    this.lastScreenSnapshot.delete(sessionId)
    this.lastConditionsSnapshot.delete(sessionId)
    this.lastTranscriptFile.delete(sessionId)
    this.codexCandidateObservationEdges.delete(sessionId)
    this.codexAttachmentObservationState.delete(sessionId)
    this.lastInputReadiness.delete(sessionId)
    this.lastGateEvaluation.delete(sessionId)
    this.spawnInfo.delete(sessionId)
    // Keep lastActivityAt after removal. Process telemetry can be asked about a
    // pane the renderer still knows but whose PTY already exited; deleting this
    // tiny timestamp made those recently-exited panes look like they had never
    // produced activity. Live ownership is `sessions`, not this map, so retaining
    // the timestamp does not keep a process/session alive.
    this.sessionSizes.delete(sessionId)
    if (kind === 'terminal') {
      this.terminalBuffers.delete(sessionId)
      this.terminalAttached.delete(sessionId)
    } else {
      this.agentPtyBuffers.delete(sessionId)
      this.agentPtyAttachCounts.delete(sessionId)
      this.agentPtyRestoreSizes.delete(sessionId)
      if (revokeAgentMcp) this.builtInMcpHost?.revokeSession(sessionId)
    }
    forgetFeedDebugSession(sessionId)
    return true
  }

  private throwIfRecoveryCancelled(claim?: RecoveryClaim): void {
    if (claim?.cancelled) throw new RecoveryCancelledError()
  }

  private findCodexReplacementReservation(
    sessionId: string,
  ): CodexReplacementReservationRecord | null {
    return this.codexReplacements.findReservation(sessionId)
  }

  private throwIfSpawnCancelled(
    recoveryClaim?: RecoveryClaim,
    replacementHandoff?: CodexReplacementHandoff | null,
  ): void {
    this.throwIfRecoveryCancelled(recoveryClaim)
    if (replacementHandoff?.reservation.cancelled) {
      // WHY replacement cancellation shares the recovery cancellation error:
      // both mean main deliberately revoked this startup generation. The spawn
      // transaction must run its ordinary generation-owned rollback, while the
      // outer replacement layer must distinguish this from a provider failure
      // and suppress compensation. A provider-specific exception would tempt
      // callers to handle teardown policy below SessionManager.
      throw new RecoveryCancelledError()
    }
  }

  private requestEntryStop(sessionId: string, entry: RegistryEntry): Promise<void> {
    const lifecycle = entry.lifecycle
    lifecycle.stopRequested = true
    if (!lifecycle.startSettled) lifecycle.stopRequestedBeforeStartSettled = true
    if (!lifecycle.stopPromise) {
      lifecycle.stopPromise = Promise.resolve()
        .then(() => entry.session.stop())
        .catch(error => {
          // WHY stop failures are diagnostic, not ownership failures: main
          // must still sever the registry/MCP references even when a provider
          // wrapper cannot prove its child exited. Retaining a writable entry
          // after stop rejected is strictly worse than recording the failure
          // and allowing the provider/process supervisor to finish cleanup.
          performanceService.error('session.stop.error', error, {
            sessionId,
            kind: entry.kind,
          })
        })
    }
    return lifecycle.stopPromise
  }

  private async settleEntryStart(
    sessionId: string,
    entry: RegistryEntry,
  ): Promise<void> {
    const lifecycle = entry.lifecycle
    lifecycle.startSettled = true
    if (!lifecycle.stopRequestedBeforeStartSettled) return
    if (!lifecycle.postStartStopPromise) {
      // WHY a second, post-start stop is intentional: some wrappers can finish
      // acquiring their PTY/proxy/server after an earlier stop() returned.
      // The first stop makes kill responsive; this generation-owned second
      // stop closes anything that materialized late. It runs at most once and
      // never targets a replacement entry.
      lifecycle.postStartStopPromise = Promise.resolve()
        .then(() => entry.session.stop())
        .catch(error => {
          performanceService.error('session.stop.postStart.error', error, {
            sessionId,
            kind: entry.kind,
          })
        })
    }
    // WHY invoke the post-start stop before awaiting the first one: the first
    // stop may itself be waiting for startup to finish. Waiting on it here
    // would deadlock the second stop behind the exact pre-start race it exists
    // to repair. Start settlement launches the second attempt immediately,
    // then the generation fence remains held until both teardown attempts have
    // settled.
    await Promise.all([
      lifecycle.stopPromise ?? Promise.resolve(),
      lifecycle.postStartStopPromise,
    ])
  }

  private removeEntryListeners(entry: RegistryEntry): void {
    try {
      const maybe = (entry.session as { removeAllListeners?: () => void })
        .removeAllListeners
      maybe?.call(entry.session)
    } catch {
      // Listener cleanup is best-effort and must never block ownership release.
    }
  }

  private replacementOwnershipMatches(
    ownership: SessionOwnershipOptions | null,
    options: SessionRecoverOptions,
  ): boolean {
    if (!ownership) return false
    return (
      (ownership.kind ?? DEFAULT_PROVIDER) === (options.kind ?? DEFAULT_PROVIDER) &&
      path.resolve(ownership.cwd) === path.resolve(options.cwd)
    )
  }

  private cancelCodexReplacementReservation(
    reservation: CodexReplacementReservationRecord,
    teardownIntent: 'explicit-close' | 'shutdown' | null,
  ): void {
    reservation.cancelled = true
    if (reservation.restorationClaim) {
      // Compensation and pending-reclaim restoration are reservation-caused
      // generations even when no renderer reclaim exists. Publish cancellation
      // synchronously so either reservation identity can revoke startup before
      // killInternal begins its generation-scoped stop.
      reservation.restorationClaim.cancelled = true
    }
    if (teardownIntent && !reservation.teardownIntent) {
      reservation.teardownIntent = teardownIntent
    }
    const reclaim = this.codexReplacements.getReclaim(
      reservation.predecessorSessionId,
    )
    if (reclaim) this.markCodexReplacementReclaimCancelled(reclaim)
  }

  private markCodexReplacementReclaimCancelled(
    reclaim: CodexReplacementReclaim<RecoveryClaim>,
  ): void {
    reclaim.cancelled = true
    if (reclaim.restorationClaim) reclaim.restorationClaim.cancelled = true
    // WHY close propagates across every alias sharing the physical successor:
    // flattened P→T/S→T redirects are stale names for one rollout. If close(S)
    // cancels the winning P reclaim but leaves P→T active, P can retry after the
    // cancelled start settles and resurrect the same lineage. Tombstoning the
    // sibling routes is not broader authority; admission already proved they
    // converge on the reclaim's exact successor generation.
    for (const redirect of this.codexReplacements.findRedirects(
      reclaim.successorSessionId,
    )) {
      if (redirect.successorSessionId === reclaim.successorSessionId) {
        redirect.cancelled = true
      }
    }
  }

  private preserveClosedCodexReplacementLineage(
    reservation: CodexReplacementReservationRecord,
  ): boolean {
    if (
      !reservation.teardownIntent ||
      !reservation.predecessorOwnership ||
      !reservation.restoreOptions
    ) {
      return false
    }
    // WHY cancellation before workspace commit still needs a redirect-shaped
    // record: durable bytes may still name predecessorId while a second loaded
    // renderer may still name successorId. Explicit close is authoritative for
    // both. Dropping the reservation without this tombstone made either stale
    // identity capable of recreating the just-closed rollout.
    return this.codexReplacements.tombstoneReservationLineage(reservation)
  }

  private retireCodexReplacementReservation(
    reservation: CodexReplacementReservationRecord,
  ): void {
    // WHY every non-commit removal resolves the same capability: an immediate
    // S→T request can be waiting for pending P→S to become durable. Close,
    // reclaim, failed startup, and shutdown all make S invalid as the next
    // replacement predecessor. Waking that waiter as "retired" lets it abort
    // instead of hanging forever or falling through to an ordinary spawn.
    reservation.settleDurability('retired')
    if (this.preserveClosedCodexReplacementLineage(reservation)) return
    this.codexReplacements.deleteReservation(reservation)
  }

  private replacementRecoveryCancelled(
    sessionId: string,
  ): SessionRecoverResult {
    return {
      ok: false,
      code: 'cancelled',
      retryable: true,
      message: `Replacement recovery for session ${sessionId} was cancelled`,
    }
  }

  private replacementReclaimConflict(
    sessionId: string,
  ): SessionRecoverResult {
    return {
      ok: false,
      code: 'ownership-conflict',
      retryable: true,
      message: `Session ${sessionId} shares a successor with an active replacement reclaim`,
    }
  }

  private beginCodexReplacementReclaim(
    options: SessionRecoverOptions,
    successorSessionId: string,
    run: (
      reclaim: CodexReplacementReclaim<RecoveryClaim>,
    ) => Promise<SessionRecoverResult>,
  ): CodexReplacementReclaim<RecoveryClaim> {
    const reclaim: CodexReplacementReclaim<RecoveryClaim> = {
      predecessorSessionId: options.sessionId,
      successorSessionId,
      kind: options.kind ?? DEFAULT_PROVIDER,
      cwd: path.resolve(options.cwd),
      recoveryTokens: new Set([options.recoveryToken ?? randomUUID()]),
      cancelled: false,
      restorationClaim: null,
      // Replaced before publication. As with RecoveryClaim, the placeholder
      // prevents the async body from crossing its first boundary before
      // cancellation can address the fully formed generation.
      promise: new Promise<SessionRecoverResult>(() => {}),
    }
    // Publish both identity indices while the promise is still an inert
    // placeholder. Scheduling the async body before the final admission check
    // would let a defensive collision throw to the caller while untracked
    // teardown still runs in a microtask.
    if (!this.codexReplacements.setReclaim(reclaim)) {
      throw new Error('Codex replacement lineage already has an active reclaim')
    }
    reclaim.promise = Promise.resolve()
      .then(() => run(reclaim))
      .finally(() => {
        this.codexReplacements.deleteReclaim(reclaim)
      })
    return reclaim
  }

  private reclaimPendingCodexReplacement(
    options: SessionRecoverOptions,
    reservation: CodexReplacementReservationRecord,
  ): Promise<SessionRecoverResult> {
    if (!this.replacementOwnershipMatches(reservation.predecessorOwnership, options)) {
      return Promise.resolve(this.recoveryConflict(options.sessionId, null))
    }
    if (reservation.reclaimPromise) {
      const activeReclaim = this.codexReplacements.getReclaim(
        reservation.predecessorSessionId,
      )
      if (activeReclaim && options.recoveryToken) {
        // A renderer reload can join work whose original deadline vanished with
        // the old renderer. The token belongs to this published generation—not
        // to a future reuse of the stable ID—so keeping it on the reclaim record
        // lets the new renderer retire the exact work it is now awaiting.
        activeReclaim.recoveryTokens.add(options.recoveryToken)
      }
      return reservation.reclaimPromise
    }
    if (
      this.codexReplacements.getReclaimBySuccessor(
        reservation.successorSessionId,
      )
    ) {
      return Promise.resolve(this.replacementReclaimConflict(options.sessionId))
    }

    reservation.reclaimRequested = true
    const reclaim = this.beginCodexReplacementReclaim(
      options,
      reservation.successorSessionId,
      async reclaimGeneration => {
        await reservation.spawnSettled

        if (reservation.spawnOutcome === 'successor-live') {
          // WHY this stop carries transaction authority: the successor is live
          // only because the abandoned renderer asked main to transfer the exact
          // rollout. Rehydrate still owns predecessorId durably, so reclamation
          // must retire that hidden owner without reclassifying the event as a
          // user close (which would suppress the stable-ID recovery below).
          await this.killInternal(reservation.successorSessionId, reservation)
        }
        if (
          reservation.cancelled ||
          reclaimGeneration.cancelled ||
          this.shuttingDown
        ) {
          this.retireCodexReplacementReservation(reservation)
          return this.replacementRecoveryCancelled(options.sessionId)
        }
        const recoveryPromise = this.recover({
          ...(reservation.restoreOptions ?? options),
          sessionId: reservation.predecessorSessionId,
          recoveryToken: options.recoveryToken,
          reclaimPendingReplacement: false,
        })
        const restorationClaim = this.recoveriesInFlight.get(
          reservation.predecessorSessionId,
        ) ?? null
        if (restorationClaim) {
          // WHY the reservation survives this await: disk still names P, while
          // the stopped hidden owner was S. Close can legitimately arrive by
          // either identity until restored P is settled, and the reservation is
          // the only record that both authenticates S and can turn explicit
          // predecessor close into a durable process-lifetime tombstone.
          reservation.restorationClaim = restorationClaim
          reclaimGeneration.restorationClaim = restorationClaim
          for (const token of reclaimGeneration.recoveryTokens) {
            restorationClaim.recoveryTokens.add(token)
          }
        }
        const result = await recoveryPromise
        if (reservation.restorationClaim === restorationClaim) {
          reservation.restorationClaim = null
        }
        if (reclaimGeneration.restorationClaim === restorationClaim) {
          reclaimGeneration.restorationClaim = null
        }
        if (
          reservation.cancelled ||
          reclaimGeneration.cancelled ||
          this.shuttingDown
        ) {
          this.retireCodexReplacementReservation(reservation)
          return this.replacementRecoveryCancelled(options.sessionId)
        }
        this.retireCodexReplacementReservation(reservation)
        return result
      },
    )
    reservation.reclaimPromise = reclaim.promise
    return reservation.reclaimPromise
  }

  private reclaimPersistedCodexRedirect(
    options: SessionRecoverOptions,
    redirect: CodexReplacementRedirect,
  ): Promise<SessionRecoverResult> {
    if (!this.replacementOwnershipMatches(redirect.predecessorOwnership, options)) {
      return Promise.resolve(this.recoveryConflict(options.sessionId, null))
    }
    if (redirect.reclaimPromise) {
      const activeReclaim = this.codexReplacements.getReclaim(
        redirect.predecessorSessionId,
      )
      if (activeReclaim && options.recoveryToken) {
        activeReclaim.recoveryTokens.add(options.recoveryToken)
      }
      return redirect.reclaimPromise
    }
    if (
      this.codexReplacements.getReclaimBySuccessor(redirect.successorSessionId)
    ) {
      // Flattened P→T and S→T redirects are two stale names for one
      // physical owner. Publishing both async bodies lets each teardown cancel
      // the other. Reject the later alias synchronously while the first
      // generation remains token-addressable by its own predecessor ID.
      return Promise.resolve(this.replacementReclaimConflict(options.sessionId))
    }

    const siblingRedirects = this.codexReplacements
      .findRedirects(redirect.successorSessionId)
      .filter(candidate => candidate !== redirect)
    const reclaim = this.beginCodexReplacementReclaim(
      options,
      redirect.successorSessionId,
      async reclaimGeneration => {
        if (
          redirect.cancelled ||
          reclaimGeneration.cancelled ||
          this.shuttingDown
        ) {
          // Cancellation can win before this microtask starts. The redirect still
          // names the exact rollout owner, so retire it even though restoration
          // is now forbidden; otherwise a timed-out reclaim would leave the
          // successor alive and unreachable from the renderer that gave up.
          await this.killInternal(redirect.successorSessionId, null, redirect)
          return this.replacementRecoveryCancelled(options.sessionId)
        }
        // A later replacement may already be active for this target. Public
        // teardown semantics are correct in that case: cancel the newer transfer
        // and cascade through its hidden successor before the stale durable ID is
        // allowed to resume the rollout.
        const nestedReplacement = this.codexReplacements.getReservationByPredecessor(
          redirect.successorSessionId,
        )
        await this.killInternal(redirect.successorSessionId, null, redirect)
        // stop() can return before a provider start generation finishes its
        // second late-materialization stop. Joining the nested transaction keeps
        // the stale predecessor from racing that still-physical rollout owner
        // merely because the local registry rows are already gone.
        if (nestedReplacement) await nestedReplacement.spawnSettled
        if (
          redirect.cancelled ||
          reclaimGeneration.cancelled ||
          this.shuttingDown
        ) {
          // Keep the cancelled redirect as a process-lifetime tombstone. The
          // current renderer has explicitly closed this ownership lineage, while
          // another stale renderer may still hold predecessorId in memory. If we
          // delete the only evidence here, that later bootstrap falls through to
          // ordinary recover and resurrects a pane the user already closed.
          return this.replacementRecoveryCancelled(options.sessionId)
        }
        const recoveryPromise = this.recover({
          ...redirect.restoreOptions,
          sessionId: redirect.predecessorSessionId,
          recoveryToken: options.recoveryToken,
          reclaimPendingReplacement: false,
        })
        const restorationClaim = this.recoveriesInFlight.get(
          redirect.predecessorSessionId,
        ) ?? null
        if (restorationClaim) {
          // WHY a committed redirect uses the same explicit association as
          // pending-handoff compensation: after successor teardown, provider
          // ownership moves under predecessorId while UI close can still arrive
          // through successorId or another flattened alias. Without this link,
          // close marks the reclaim cancelled but cannot stop the backend that
          // is already materializing under the other routing identity.
          reclaimGeneration.restorationClaim = restorationClaim
        }
        const result = await recoveryPromise
        if (reclaimGeneration.restorationClaim === restorationClaim) {
          reclaimGeneration.restorationClaim = null
        }
        if (
          redirect.cancelled ||
          reclaimGeneration.cancelled ||
          this.shuttingDown
        ) {
          return this.replacementRecoveryCancelled(options.sessionId)
        }
        if (result.ok) {
          this.codexReplacements.deleteRedirect(redirect)
          const restoredOwnership: SessionOwnershipOptions = {
            sessionId: redirect.predecessorSessionId,
            kind: result.snapshot.kind,
            cwd: result.snapshot.cwd,
          }
          for (const sibling of siblingRedirects) {
            if (
              sibling.cancelled ||
              sibling.successorSessionId !== redirect.successorSessionId
            ) {
              continue
            }
            // The winning stale renderer changed the one physical owner from T
            // back to P. S is still a valid stale alias, so point it at P rather
            // than deleting it (which would allow an unsafe ordinary spawn) or
            // calling the internal stop an explicit close.
            this.codexReplacements.retargetRedirect(
              sibling,
              restoredOwnership,
            )
          }
        }
        return result
      },
    )
    redirect.reclaimPromise = reclaim.promise
    void reclaim.promise.then(
      result => {
        if (
          redirect.reclaimPromise === reclaim.promise &&
          !redirect.cancelled &&
          !this.shuttingDown &&
          !result.ok &&
          result.retryable
        ) {
          // A deadline or provider start failure owns one reclaim generation,
          // not the lineage forever. Once its teardown/start attempt has
          // settled, a later renderer token may retry. Explicit close/shutdown
          // set durable cancellation elsewhere and intentionally retain the
          // settled tombstone promise.
          redirect.reclaimPromise = null
        }
      },
      () => undefined,
    )
    return redirect.reclaimPromise
  }

  /**
   * Advance successful handoffs only after the renderer's ownership map is on
   * disk. The workspace IPC calls this after its atomic rename, never before.
   */
  acknowledgePersistedSessionOwnership(sessionIds: ReadonlySet<string>): void {
    for (const reservation of this.codexReplacements.reservations()) {
      const predecessorSessionId = reservation.predecessorSessionId
      if (reservation.spawnOutcome !== 'successor-live') continue
      if (reservation.cancelled || reservation.reclaimRequested) continue
      if (
        !sessionIds.has(reservation.successorSessionId) ||
        sessionIds.has(predecessorSessionId) ||
        !reservation.predecessorOwnership ||
        !reservation.restoreOptions
      ) {
        continue
      }

      // Flatten older committed redirects so repeated reloads do not build a
      // chain whose intermediate successor has already been retired.
      for (const redirect of this.codexReplacements.redirects()) {
        if (redirect.successorSessionId === predecessorSessionId) {
          this.codexReplacements.retargetRedirect(
            redirect,
            reservation.successorOwnership,
          )
        }
      }
      this.codexReplacements.setRedirect({
        predecessorSessionId,
        successorSessionId: reservation.successorSessionId,
        predecessorOwnership: reservation.predecessorOwnership,
        successorOwnership: reservation.successorOwnership,
        restoreOptions: reservation.restoreOptions,
        cancelled: false,
        reclaimPromise: null,
      })
      this.codexReplacements.deleteReservation(reservation)
      // Resolve only after redirect publication and reservation deletion. The
      // queued S→T continuation runs in a later microtask and must observe the
      // complete durable transition, never the half-state between both maps.
      reservation.settleDurability('committed')
      this.lifecycle.session('replacement.commit', reservation.successorSessionId, {
        kind: 'codex',
        predecessorSessionId,
        ok: true,
        reason: 'workspace-persisted',
      })
    }
  }

  /**
   * Reconcile one persisted renderer pane with main's backend registry.
   *
   * WHY this is a main-owned atomic operation instead of renderer
   * get-kind-then-spawn: renderer state disappears on reload, and two
   * renderers/remote callers do not share a JavaScript single-flight. The
   * persisted local SessionId is the only ownership key. Provider history ids
   * are consumed only by the cold-spawn path and never used to adopt a process.
   */
  recover(options: SessionRecoverOptions): Promise<SessionRecoverResult> {
    const requestedKind: unknown = options.kind
    if (requestedKind !== undefined && !isSessionKind(requestedKind)) {
      // WHY validate again in main even though renderer has a type guard: IPC
      // is a runtime trust boundary and stale/newer renderers can send values
      // this build does not know. Falling through the agent-kind check would
      // otherwise interpret an unknown provider as a terminal shell.
      return Promise.resolve({
        ok: false,
        code: 'start-failed',
        retryable: false,
        message: 'This Agent Code version does not support the requested provider.',
      })
    }
    const kind = options.kind ?? DEFAULT_PROVIDER
    const cwd = path.resolve(options.cwd)
    if (this.shuttingDown) {
      return Promise.resolve({
        ok: false,
        code: 'cancelled',
        retryable: true,
        message: `Recovery for session ${options.sessionId} was cancelled during shutdown`,
      })
    }

    // WHY a replacement claim fences recovery even while the predecessor is
    // still visible: the renderer continues to address the old local ID until
    // spawn IPC returns and state remapping commits. A mount/send/navigation
    // wake in that interval must neither adopt a backend that is about to be
    // retired nor recreate the old ID after destructive handoff. The fence is
    // main-owned and lasts through compensation, so no renderer lifetime or
    // React single-flight can reopen the exact-rollout race found in review.
    const replacement = this.codexReplacements.findReservation(options.sessionId)
    if (replacement) {
      const addressesPredecessor =
        replacement.predecessorSessionId === options.sessionId
      if (
        addressesPredecessor &&
        options.reclaimPendingReplacement
      ) {
        return this.reclaimPendingCodexReplacement(options, replacement)
      }
      const owningReclaim = addressesPredecessor
        ? this.codexReplacements.getReclaim(options.sessionId)
        : null
      const entersOwnedRestore = Boolean(
        addressesPredecessor &&
        !options.reclaimPendingReplacement &&
        !replacement.cancelled &&
        owningReclaim &&
        !owningReclaim.cancelled &&
        owningReclaim.successorSessionId === replacement.successorSessionId &&
        replacement.reclaimPromise === owningReclaim.promise,
      )
      if (entersOwnedRestore) {
        // The pending reservation remains published while its exact reclaim
        // restores predecessorId. Only this predecessor+successor generation
        // may cross the fence; every renderer call still sees the reservation,
        // allowing close through either role to publish a tombstone.
      } else if (
        !addressesPredecessor &&
        !replacement.cancelled &&
        this.sessions.has(options.sessionId)
      ) {
        // The initiating renderer may recover/adopt the live successor before
        // workspace acknowledgement. The lineage fence is for a missing or
        // cancelled owner, not a reason to reject the exact current backend.
      } else if (replacement.cancelled) {
        return Promise.resolve(this.replacementRecoveryCancelled(options.sessionId))
      } else {
        this.lifecycle.session('recover.conflict', options.sessionId, {
          kind,
          code: 'ownership-conflict',
          lifecycle: 'spawning',
          reason: 'replacement-handoff',
        })
        return Promise.resolve({
          ok: false,
          code: 'ownership-conflict',
          retryable: true,
          message: `Session ${options.sessionId} is being replaced`,
        })
      }
    }
    if (this.codexReplacements.getReclaimBySuccessor(options.sessionId)) {
      // Only the winning predecessor redirect carries reclaimPromise; its
      // flattened siblings do not. The successor-keyed generation is therefore
      // the source of truth that keeps reverse recovery from adopting or
      // recreating T while any stale alias owns its teardown.
      return Promise.resolve(this.replacementReclaimConflict(options.sessionId))
    }
    const redirects = this.codexReplacements.findRedirects(options.sessionId)
    const predecessorRedirect = redirects.find(
      redirect => redirect.predecessorSessionId === options.sessionId,
    )
    let ownedRestoreRedirect: CodexReplacementRedirect | null = null
    if (predecessorRedirect) {
      const owningReclaim = this.codexReplacements.getReclaim(options.sessionId)
      const entersOwnedRestore = Boolean(
        !options.reclaimPendingReplacement &&
        owningReclaim &&
        owningReclaim.successorSessionId ===
          predecessorRedirect.successorSessionId &&
        predecessorRedirect.reclaimPromise === owningReclaim.promise,
      )
      if (!entersOwnedRestore) {
        if (predecessorRedirect.cancelled) {
          return Promise.resolve(this.replacementRecoveryCancelled(options.sessionId))
        }
        if (options.reclaimPendingReplacement) {
          return this.reclaimPersistedCodexRedirect(options, predecessorRedirect)
        }
        return Promise.resolve({
          ok: false,
          code: 'ownership-conflict',
          retryable: true,
          message: `Session ${options.sessionId} has a persisted replacement`,
        })
      }
      // The winning reclaim must keep its redirect published across provider
      // startup so close/timeout can still address the lineage. Only this exact
      // predecessor+successor generation may pass through to ordinary recovery;
      // every external caller continues to hit the redirect fence above.
      ownedRestoreRedirect = predecessorRedirect
    }
    const externalRedirects = ownedRestoreRedirect
      ? redirects.filter(redirect => redirect !== ownedRestoreRedirect)
      : redirects
    if (externalRedirects.some(redirect => redirect.cancelled)) {
      return Promise.resolve(this.replacementRecoveryCancelled(options.sessionId))
    }
    if (externalRedirects.some(redirect =>
      redirect.successorSessionId === options.sessionId &&
      !this.replacementOwnershipMatches(redirect.successorOwnership, options)
    )) {
      // Natural exit removes the registry snapshot, but a committed redirect
      // still knows who the current successor was. Trusting stale predecessor
      // cwd here would cold-spawn S under P's filesystem context and defeat the
      // role-specific ownership check used by close.
      return Promise.resolve(this.recoveryConflict(options.sessionId, null))
    }
    if (externalRedirects.some(redirect => redirect.reclaimPromise)) {
      return Promise.resolve({
        ok: false,
        code: 'ownership-conflict',
        retryable: true,
        message: `Session ${options.sessionId} is being reclaimed`,
      })
    }
    // A healthy current successor is ordinary durable ownership. If it is
    // still live we adopt below; if it exited naturally we may recover it.
    // Only a cancelled or actively reclaiming reverse lineage fences B.
    const existingClaim = this.recoveriesInFlight.get(options.sessionId)
    if (existingClaim) {
      if (existingClaim.kind === kind && existingClaim.cwd === cwd) {
        if (options.recoveryToken) {
          // Compatible callers share one physical provider start. A new
          // renderer therefore joins that generation's cancellation authority
          // as well as its promise; otherwise reload destroys the only token
          // capable of retiring a hung start.
          existingClaim.recoveryTokens.add(options.recoveryToken)
        }
        this.lifecycle.session('recover.join', options.sessionId, {
          kind,
          lifecycle: 'spawning',
        })
        return existingClaim.promise
      }
      this.lifecycle.session('recover.conflict', options.sessionId, {
        kind,
        code: 'ownership-conflict',
        lifecycle: 'spawning',
        reason: 'claim-in-flight',
      })
      return Promise.resolve(this.recoveryConflict(options.sessionId, existingClaim))
    }

    const existingEntry = this.sessions.get(options.sessionId)
    if (existingEntry) {
      const snapshot = this.getBackendSnapshot(options.sessionId)
      if (snapshot && snapshot.kind === kind && path.resolve(snapshot.cwd) === cwd) {
        // Adoption carries the ADOPTED BACKEND'S readiness, not just the
        // disposition. #596 turned on exactly this distinction: a caller that
        // adopts a live-but-not-ready agent behaves completely differently from
        // one that spawned a fresh process, and until now nothing recorded
        // which case a given wake was. Pairing this with `wake.request`'s
        // caller tag is what will let the Stage 4 catalog separate them.
        this.lifecycle.session('recover.adopted', options.sessionId, {
          kind,
          disposition: 'adopted',
          lifecycle: snapshot.lifecycle,
          ready: snapshot.input.ready,
          reason: snapshot.input.reason ?? null,
          durationMs: 0,
        })
        return Promise.resolve({
          ok: true,
          disposition: 'adopted',
          snapshot,
          ...(existingEntry.kind === 'terminal' && existingEntry.tmuxName
            ? { tmuxName: existingEntry.tmuxName }
            : {}),
        })
      }
      this.lifecycle.session('recover.conflict', options.sessionId, {
        kind,
        code: 'ownership-conflict',
        lifecycle: snapshot?.lifecycle ?? 'live',
        reason: 'live-entry-mismatch',
      })
      return Promise.resolve(this.recoveryConflict(options.sessionId, snapshot))
    }

    if (this.spawningSessionGenerations.has(options.sessionId)) {
      this.lifecycle.session('recover.conflict', options.sessionId, {
        kind,
        code: 'ownership-conflict',
        lifecycle: 'spawning',
        reason: 'spawn-generation-held',
      })
      return Promise.resolve(this.recoveryConflict(options.sessionId, null))
    }

    // WHY the microtask: assigning the promise by calling an async helper first
    // would execute that helper synchronously until its first await. Provider
    // construction (and MCP registration) occurs before spawn's first
    // provider-start await and can re-enter recover(). Queueing the owner work
    // lets us publish the fully-formed claim before any of those side effects.
    const claim: RecoveryClaim = {
      kind,
      cwd,
      recoveryTokens: new Set([options.recoveryToken ?? randomUUID()]),
      startedAt: performance.now(),
      cancelled: false,
      spawnGeneration: null,
      // Replaced on the next line before the claim is published. A typed
      // never-settling placeholder keeps the object fully initialized without
      // allowing async owner work to run before recoveriesInFlight.set().
      promise: new Promise<SessionRecoverResult>(() => {}),
    }
    claim.promise = Promise.resolve().then(() => this.runRecovery(options, claim))
    this.recoveriesInFlight.set(options.sessionId, claim)
    // The moment this session becomes main-owned. Recorded because a claim that
    // is published and never followed by adopted/spawned/conflict/cancelled/
    // failed is a stranded pane — the exact state that presents to the user as
    // "the agent never started" with nothing anywhere explaining why. That
    // unterminated-claim shape is the first invariant the Stage 5 replay
    // harness will check for.
    this.lifecycle.session('recover.claim', options.sessionId, {
      kind,
      hasResumeId: Boolean(options.resumeSessionId),
    })
    return claim.promise
  }

  private recoveryConflict(
    sessionId: string,
    ownership: RecoveryClaim | SessionBackendSnapshot | null,
  ): SessionRecoverResult {
    const actual = ownership
      ? {
          kind: ownership.kind,
          cwd: ownership.cwd,
          lifecycle: 'lifecycle' in ownership ? ownership.lifecycle : 'spawning' as const,
        }
      : undefined
    return {
      ok: false,
      code: 'ownership-conflict',
      retryable: false,
      message: `Session ${sessionId} is already owned by another backend`,
      ...(actual ? { actual } : {}),
    }
  }

  private async runRecovery(
    options: SessionRecoverOptions,
    claim: RecoveryClaim,
  ): Promise<SessionRecoverResult> {
    try {
      if (claim.cancelled) {
        this.lifecycle.session('recover.cancelled', options.sessionId, {
          kind: claim.kind,
          code: 'cancelled',
          lifecycle: 'spawning',
          reason: 'cancelled-before-start',
          durationMs: performance.now() - claim.startedAt,
        })
        return {
          ok: false,
          code: 'cancelled',
          retryable: true,
          message: `Recovery for session ${options.sessionId} was cancelled`,
        }
      }
      this.lifecycle.session('spawn.begin', options.sessionId, { kind: claim.kind })
      const spawnPromise = this.spawnWithId({
        ...options,
        cwd: claim.cwd,
        kind: claim.kind,
      }, options.sessionId, claim)
      const result = await spawnPromise
      const snapshot = this.getBackendSnapshot(options.sessionId)
      if (claim.cancelled || !snapshot || snapshot.lifecycle !== 'live') {
        // A provider is allowed to resolve start() after stop() has already
        // removed its registry entry. Treating that as success would hand the
        // renderer a phantom backend; stop any late materialization and report
        // the stable cancelled outcome instead.
        // WHY recovery's own late-materialization cleanup is not a new user
        // teardown intent: a replacement may have cancelled this predecessor
        // recovery on purpose. Calling public kill() here would rediscover that
        // reservation and cancel the very replacement that owns the cleanup.
        // If a real close already cancelled the reservation, its flag remains
        // set; authorization only prevents this internal follow-up from
        // manufacturing a second cause.
        await this.killInternal(
          options.sessionId,
          this.findCodexReplacementReservation(options.sessionId),
        )
        this.lifecycle.session('recover.cancelled', options.sessionId, {
          kind: claim.kind,
          code: 'cancelled',
          lifecycle: snapshot?.lifecycle ?? 'spawning',
          // Distinguishes "the user closed the pane mid-start" from a provider
          // that resolved start() after its registry entry was already gone.
          // Both return `cancelled` to the renderer, but only the latter is a
          // provider-behaviour question worth chasing.
          reason: claim.cancelled ? 'cancelled-during-start' : 'entry-vanished',
          durationMs: performance.now() - claim.startedAt,
        })
        return {
          ok: false,
          code: 'cancelled',
          retryable: true,
          message: `Recovery for session ${options.sessionId} was cancelled`,
        }
      }
      this.lifecycle.session('recover.spawned', options.sessionId, {
        kind: claim.kind,
        disposition: 'spawned',
        lifecycle: snapshot.lifecycle,
        // A cold-spawned backend is almost never ready at this instant. Capturing
        // readiness HERE gives the corpus a baseline to measure "minutes to
        // start" against: the interval between this event and the first
        // `readiness.publish` with ready:true is the number nobody has ever had.
        ready: snapshot.input.ready,
        reason: snapshot.input.reason ?? null,
        durationMs: performance.now() - claim.startedAt,
      })
      return {
        ok: true,
        disposition: 'spawned',
        snapshot,
        ...(result.tmuxName ? { tmuxName: result.tmuxName } : {}),
      }
    } catch (error) {
      if (claim.cancelled) {
        this.lifecycle.session('recover.cancelled', options.sessionId, {
          kind: claim.kind,
          code: 'cancelled',
          lifecycle: 'spawning',
          reason: 'cancelled-after-throw',
          durationMs: performance.now() - claim.startedAt,
        })
        return {
          ok: false,
          code: 'cancelled',
          retryable: true,
          message: `Recovery for session ${options.sessionId} was cancelled`,
        }
      }
      this.lifecycle.session('recover.failed', options.sessionId, {
        kind: claim.kind,
        code: 'start-failed',
        lifecycle: 'spawning',
        durationMs: performance.now() - claim.startedAt,
      })
      return {
        ok: false,
        code: 'start-failed',
        retryable: true,
        // WHY the raw provider exception stays out of IPC: binary launch
        // errors can contain environment values, proxy URLs, or scoped MCP
        // tokens. Main records the typed code and internal performance error;
        // renderer receives one stable, actionable message with no payload.
        message: 'Session failed to start. Check provider setup and retry.',
      }
    } finally {
      if (this.recoveriesInFlight.get(options.sessionId) === claim) {
        this.recoveriesInFlight.delete(options.sessionId)
      }
    }
  }

  /**
   * Spawn a new session and return its sessionId. Blocks until the PTY
   * is spawned — after this resolves the caller can immediately start
   * sending input via `write()`.
   *
   * For Claude sessions, start() also attaches the JSONL watcher; for
   * terminal sessions it's just the PTY spawn.
   */
  async spawn(
    options: SessionSpawnOptions,
    /**
     * Called with the freshly minted id, synchronously, BEFORE anything can
     * emit an event for it.
     *
     * WHY this exists rather than the caller claiming ownership from the
     * resolved result: `spawn()` awaits the provider start, and the provider
     * emits `started`, the first screen snapshot, and its first semantic events
     * during that await. A caller that waited for the promise would have no way
     * to route those, because nobody outside this method knows the id yet. The
     * window registry needs the id at mint time or its routing has a hole
     * exactly where a new pane's first paint lives.
     *
     * It is a callback rather than an `ownerWindowId` option so SessionManager
     * stays ignorant of windows; it hands out an id and does not care who
     * claims it.
     */
    onSessionIdMinted?: (sessionId: string) => void,
  ): Promise<SessionSpawnResult> {
    const requestedKind: unknown = options.kind
    if (requestedKind !== undefined && !isSessionKind(requestedKind)) {
      throw new Error('Unsupported session provider')
    }
    const kind: SessionKind = options.kind ?? DEFAULT_PROVIDER
    const sessionId = randomUUID()
    onSessionIdMinted?.(sessionId)
    const codexHandoffClaim = await this.prepareCodexReplacementHandoff(
      options,
      sessionId,
      kind,
    )
    try {
      const result = await this.spawnWithId(
        options,
        sessionId,
        undefined,
        codexHandoffClaim,
      )
      if (!codexHandoffClaim) return result

      const reservation = codexHandoffClaim.reservation
      reservation.spawnOutcome = 'successor-live'
      reservation.settleSpawn()
      // A fresh renderer can request the still-durable predecessor while the
      // abandoned spawn IPC is finishing. Let that reclaim transaction retire
      // the hidden successor and restore the stable ID before the old renderer
      // is allowed to observe a success it can no longer commit.
      if (reservation.reclaimRequested && reservation.reclaimPromise) {
        await reservation.reclaimPromise
        throw new RecoveryCancelledError()
      }
      return {
        ...result,
        replacementTransactionId: reservation.transactionId,
      }
    } catch (error) {
      // A same-rollout successor can fail after the exact ownership boundary:
      // prompt-profile attestation, PTY spawn, and headless start all happen
      // after the predecessor must release its lease. The old renderer state is
      // still keyed by predecessorSessionId because replaceSession has not
      // returned. Restore that ID before surfacing the successor error so a
      // failed reload remains a failed reload, not a dead pane.
      if (
        codexHandoffClaim?.compensationRequired &&
        codexHandoffClaim.reservation.spawnOutcome !== 'successor-live' &&
        !codexHandoffClaim.reservation.cancelled
      ) {
        await this.restoreCodexReplacementPredecessor(codexHandoffClaim)
      }
      if (codexHandoffClaim?.reservation.spawnOutcome === 'pending') {
        codexHandoffClaim.reservation.spawnOutcome = 'failed'
        codexHandoffClaim.reservation.settleSpawn()
      }
      throw error
    } finally {
      // Successor start is only the PROCESS half of the transaction. The
      // renderer still has to make its random local id durable. Keeping the
      // reservation after success lets a reload that retained predecessorId
      // reclaim safely; workspace persistence later moves it to a bounded
      // redirect tombstone. Failed/cancelled/reclaimed attempts are terminal.
      if (
        options.predecessorSessionId &&
        codexHandoffClaim &&
        codexHandoffClaim.reservation.spawnOutcome !== 'successor-live' &&
        this.codexReplacements.getReservationByPredecessor(
          options.predecessorSessionId,
        ) === codexHandoffClaim.reservation
      ) {
        this.retireCodexReplacementReservation(codexHandoffClaim.reservation)
      }
    }
  }

  /**
   * Stop the exact local Codex predecessor only when this spawn will resume the
   * same physical transcript.
   *
   * WHY this policy cannot live in codex-headless: its coordinator deliberately
   * knows files and proof, not Agent Code pane intent. Teaching it that a second
   * owner is "sometimes a replacement" would weaken the cross-wire boundary for
   * every consumer. Main owns both local backends and can prove that the caller
   * named the predecessor it is replacing before retiring that one lease.
   */
  private async prepareCodexReplacementHandoff(
    options: SessionSpawnOptions,
    successorSessionId: string,
    kind: SessionKind,
  ): Promise<CodexReplacementHandoff | null> {
    const predecessorSessionId = options.predecessorSessionId
    if (kind !== 'codex' || !options.resumeSessionId || !predecessorSessionId) {
      return null
    }
    if (predecessorSessionId === successorSessionId) {
      throw new Error('A session cannot replace its own local routing id')
    }

    let waitedForPredecessorDurability = false
    while (true) {
      const existing = this.findCodexReplacementReservation(predecessorSessionId)
      if (!existing) break
      const replacesLivePendingSuccessor =
        existing.successorSessionId === predecessorSessionId &&
        existing.spawnOutcome === 'successor-live' &&
        !existing.cancelled &&
        !existing.reclaimRequested
      if (!replacesLivePendingSuccessor) {
        // A repeated request against P while P→S is still stopping/starting is
        // a true collision. Only S—the already-returned live successor—may join
        // the durability boundary before beginning a later transaction.
        throw new Error('A Codex replacement is already in progress for this session')
      }

      waitedForPredecessorDurability = true
      // WHY queue in main instead of accepting overlapping reservations: until
      // workspace.json names S, P remains the sole durable fallback. Starting
      // S→T now would require P→S and S→T to share close/reclaim authority while
      // neither renderer snapshot proves the middle owner. The existing P→S
      // transaction already has the exact event we need, so join it and keep a
      // single ownership graph.
      const outcome = await existing.durabilitySettled
      if (outcome !== 'committed') throw new RecoveryCancelledError()
    }

    if (waitedForPredecessorDurability) {
      const predecessorStillLive = this.sessions.has(predecessorSessionId)
      const predecessorWasClosed = this.codexReplacements
        .findRedirects(predecessorSessionId)
        .some(redirect => redirect.cancelled)
      if (!predecessorStillLive || predecessorWasClosed) {
        // Commit and close can race before this promise continuation runs. A
        // missing/tombstoned S must cancel the queued command; returning null
        // would reinterpret it as an unrelated fresh spawn and resurrect a pane
        // whose replacement authority disappeared while it waited.
        throw new RecoveryCancelledError()
      }
    }

    // Publish the claim before transcript resolution awaits. Two IPC calls can
    // otherwise both inspect the same live predecessor, both wait on disk, and
    // then both stop/start against one exact lease.
    let settleSpawn!: () => void
    const spawnSettled = new Promise<void>(resolve => {
      settleSpawn = resolve
    })
    let settleDurability!: (
      outcome: 'committed' | 'retired',
    ) => void
    const durabilitySettled = new Promise<'committed' | 'retired'>(resolve => {
      settleDurability = resolve
    })
    const reservation: CodexReplacementReservationRecord = {
      transactionId: randomUUID(),
      predecessorSessionId,
      successorSessionId,
      predecessorOwnership: null,
      successorOwnership: {
        sessionId: successorSessionId,
        kind: 'codex',
        cwd: options.cwd,
      },
      restoreOptions: null,
      cancelled: false,
      teardownIntent: null,
      reclaimRequested: false,
      spawnOutcome: 'pending',
      spawnSettled,
      settleSpawn,
      durabilitySettled,
      settleDurability,
      reclaimPromise: null,
      restorationClaim: null,
    }
    this.codexReplacements.registerReservation(reservation)
    const release = (): void => {
      if (reservation.spawnOutcome === 'pending') {
        reservation.spawnOutcome = 'failed'
        reservation.settleSpawn()
      }
      if (reservation.cancelled) {
        this.retireCodexReplacementReservation(reservation)
      } else {
        reservation.settleDurability('retired')
        this.codexReplacements.deleteReservation(reservation)
      }
    }

    try {
      const predecessor = this.sessions.get(predecessorSessionId)
      const predecessorInfo = this.spawnInfo.get(predecessorSessionId)
      if (!predecessor || predecessor.kind !== 'codex' || !predecessorInfo) {
        release()
        return null
      }
      const predecessorOwnership: SessionOwnershipOptions = {
        sessionId: predecessorSessionId,
        kind: predecessorInfo.kind,
        cwd: predecessorInfo.cwd,
      }
      reservation.predecessorOwnership = predecessorOwnership
      const predecessorRecovery =
        this.recoveriesInFlight.get(predecessorSessionId) ?? null

      let proof: CodexReplacementProof | null =
        predecessorInfo.resumeSessionId === options.resumeSessionId
          ? 'same-resume-id'
          : null

      // Fresh Codex panes learn their provider id from session_meta after
      // spawn, so spawnInfo has no resume id for them. The observed transcript
      // file is still main-owned durable evidence. Resolve the requested id
      // through the provider's exact locator and compare paths; do not infer
      // equality from cwd or UI metadata.
      if (!proof) {
        const observedPath = this.lastTranscriptFile.get(predecessorSessionId)
        if (observedPath) {
          const requestedPath = await resolveProviderTranscriptPath({
            kind: 'codex',
            cwd: options.cwd,
            providerSessionId: options.resumeSessionId,
          })
          if (
            requestedPath &&
            path.resolve(requestedPath) === path.resolve(observedPath)
          ) {
            proof = 'same-transcript-path'
          }
        }
      }

      if (!proof) {
        if (reservation.cancelled) {
          // A negative proof removes the candidate's lineage authority; it does
          // not undo the close that won while disk resolution was pending. If
          // we returned null here, spawnWithId would reinterpret the same closed
          // request as an ordinary new pane and start it after teardown.
          release()
          throw new RecoveryCancelledError()
        }
        release()
        return null
      }

      const size = this.sessionSizes.get(predecessorSessionId)
      const effectiveDomains =
        this.builtInMcpHost?.sessionDomains?.(predecessorSessionId) ?? []
      const restoreOptions: SessionSpawnOptions = {
        kind: 'codex',
        cwd: predecessorInfo.cwd,
        resumeSessionId: options.resumeSessionId,
        ...(size ? { cols: size.cols, rows: size.rows } : {}),
        dangerousMode: predecessorInfo.dangerousMode,
        useProxy: predecessorInfo.useProxy,
        builtInMcpDomains: effectiveDomains,
      }
      reservation.restoreOptions = restoreOptions
      // Path proof can be the awaited boundary where explicit close wins. The
      // resolved path must first establish whether this random successor belongs
      // to the closed lineage; only then is it safe to publish restore material
      // and let release() convert the reservation into a tombstone.
      if (reservation.cancelled) throw new RecoveryCancelledError()
      const handoff: CodexReplacementHandoff = {
        reservation,
        predecessorSessionId,
        predecessorOwnership,
        predecessorEntry: predecessor,
        predecessorRecovery,
        proof,
        // WHY compensation resumes the requested exact provider ID even when
        // the predecessor began as a fresh pane: session_meta may have taught
        // the renderer/main path cache the durable ID after launch, while the
        // original spawnInfo necessarily contains null. The path/ID proof above
        // is what authorizes this value; copying null would create a fresh
        // session and abandon the pane's transcript after a failed reload.
        restoreOptions,
        stopPromise: null,
        compensationRequired: false,
      }
      return handoff
    } catch (error) {
      release()
      throw error
    }
  }

  /**
   * Execute the destructive half of an already-proven Codex replacement.
   *
   * Codex invokes this closure only after its proxy/config launch preflight and
   * immediately before exact rollout preparation. Keeping policy here means the
   * runtime cannot name or tear down panes, while keeping timing there avoids
   * killing a healthy predecessor for failures that never needed its lease.
   */
  private async executeCodexReplacementHandoff(
    handoff: CodexReplacementHandoff,
    successorSessionId: string,
  ): Promise<void> {
    if (handoff.stopPromise) return await handoff.stopPromise

    handoff.stopPromise = (async () => {
      const startedAt = performance.now()
      this.lifecycle.session('replacement.handoff.begin', successorSessionId, {
        kind: 'codex',
        predecessorSessionId: handoff.predecessorSessionId,
        hasResumeId: true,
        reason: handoff.proof,
      })
      const throwCancelled = (): never => {
        this.lifecycle.session('replacement.handoff.end', successorSessionId, {
          kind: 'codex',
          predecessorSessionId: handoff.predecessorSessionId,
          ok: false,
          reason: 'replacement-cancelled',
          durationMs: performance.now() - startedAt,
        })
        throw new RecoveryCancelledError()
      }
      if (handoff.reservation.cancelled) throwCancelled()

      const currentEntry = this.sessions.get(handoff.predecessorSessionId)
      let handoffReason: string = handoff.proof
      if (currentEntry === handoff.predecessorEntry) {
        const stopped = await this.killOwnedInternal(
          handoff.predecessorOwnership,
          handoff.reservation,
        )
        if (stopped) handoff.compensationRequired = true
        if (!stopped) {
          this.lifecycle.session('replacement.handoff.end', successorSessionId, {
            kind: 'codex',
            predecessorSessionId: handoff.predecessorSessionId,
            ok: false,
            reason: 'predecessor-ownership-changed',
            durationMs: performance.now() - startedAt,
          })
          throw new Error('Codex replacement predecessor is no longer owned by this pane')
        }
      } else if (
        !currentEntry &&
        handoff.predecessorEntry.lifecycle.naturalExitObserved
      ) {
        // WHY a missing registry row is insufficient proof: explicit close and
        // natural process exit both remove the row. Only the captured
        // generation's synchronous exit listener can authorize this branch.
        // Joining stop here lets the wrapper retire watchers/proxy/rollout
        // ownership before the successor asks the fail-closed coordinator for
        // the same path. A naturally dead pane is not compensation-eligible.
        await this.requestEntryStop(
          handoff.predecessorSessionId,
          handoff.predecessorEntry,
        )
        handoffReason = 'predecessor-natural-exit'
      } else {
        this.lifecycle.session('replacement.handoff.end', successorSessionId, {
          kind: 'codex',
          predecessorSessionId: handoff.predecessorSessionId,
          ok: false,
          reason: 'predecessor-ownership-changed',
          durationMs: performance.now() - startedAt,
        })
        throw new Error('Codex replacement predecessor is no longer owned by this pane')
      }
      if (handoff.reservation.cancelled) throwCancelled()
      this.lifecycle.session('replacement.handoff.end', successorSessionId, {
        kind: 'codex',
        predecessorSessionId: handoff.predecessorSessionId,
        ok: true,
        reason: handoffReason,
        durationMs: performance.now() - startedAt,
      })
    })()
    return await handoff.stopPromise
  }

  /** Restore the old local routing ID after a post-handoff successor failure. */
  private async restoreCodexReplacementPredecessor(
    handoff: CodexReplacementHandoff,
  ): Promise<void> {
    const startedAt = performance.now()
    this.lifecycle.session(
      'replacement.rollback.begin',
      handoff.predecessorSessionId,
      {
        kind: 'codex',
        predecessorSessionId: handoff.predecessorSessionId,
        hasResumeId: true,
        reason: 'successor-start-failed',
      },
    )
    try {
      // A handoff can interrupt a recovery after its registry row is visible
      // but before that generation's start/rollback finally releases the stable
      // ID fence. stop() alone is not that settlement proof. Joining the exact
      // captured claim keeps compensation from becoming a one-shot "already
      // live" failure while preserving the late-materialization safety fence.
      if (handoff.predecessorRecovery) {
        await handoff.predecessorRecovery.promise
      }
      if (handoff.reservation.cancelled) {
        this.lifecycle.session(
          'replacement.rollback.end',
          handoff.predecessorSessionId,
          {
            kind: 'codex',
            predecessorSessionId: handoff.predecessorSessionId,
            ok: false,
            reason: 'replacement-cancelled',
            durationMs: performance.now() - startedAt,
          },
        )
        return
      }
      if (this.recoveriesInFlight.has(handoff.predecessorSessionId)) {
        throw new Error('Codex predecessor recovery did not release its claim')
      }

      const restoreOptions: SessionRecoverOptions = {
        ...handoff.restoreOptions,
        sessionId: handoff.predecessorSessionId,
      }
      const claim: RecoveryClaim = {
        kind: 'codex',
        cwd: path.resolve(handoff.restoreOptions.cwd),
        // Compensation is a new generation even though it reuses the stable
        // local ID. It must never inherit the timeout token belonging to the
        // interrupted predecessor recovery.
        recoveryTokens: new Set([randomUUID()]),
        startedAt: performance.now(),
        cancelled: false,
        spawnGeneration: null,
        promise: new Promise<SessionRecoverResult>(() => {}),
      }
      const reclaim = this.codexReplacements.getReclaim(
        handoff.predecessorSessionId,
      )
      // Compensation is caused by the reservation, not by rehydrate. A failed
      // replacement can enter this path before any renderer asks to reclaim,
      // so successor-addressed close/shutdown must be able to follow the
      // reservation directly to the predecessor-keyed provider generation.
      handoff.reservation.restorationClaim = claim
      if (reclaim) {
        // This link is narrower than sharing tokens: only the reclaim that was
        // already waiting on this reservation may cancel the compensation it
        // caused. An unrelated prior recovery token remains unable to target C.
        reclaim.restorationClaim = claim
      }
      // WHY compensation publishes the same claim as ordinary recovery before
      // its first await: close/shutdown must be able to cancel resolveToolPath,
      // conventions reconciliation, MCP registration, provider construction,
      // and provider start. Direct spawnWithId compensation made every
      // pre-entry await an invisible resurrection window.
      claim.promise = Promise.resolve().then(() =>
        this.runRecovery(restoreOptions, claim),
      )
      this.recoveriesInFlight.set(handoff.predecessorSessionId, claim)
      this.lifecycle.session('recover.claim', handoff.predecessorSessionId, {
        kind: 'codex',
        hasResumeId: true,
        reason: 'replacement-compensation',
      })
      const result = await claim.promise
      if (handoff.reservation.restorationClaim === claim) {
        handoff.reservation.restorationClaim = null
      }
      if (reclaim?.restorationClaim === claim) {
        reclaim.restorationClaim = null
      }
      if (!result.ok) {
        this.lifecycle.session(
          'replacement.rollback.end',
          handoff.predecessorSessionId,
          {
            kind: 'codex',
            predecessorSessionId: handoff.predecessorSessionId,
            ok: false,
            reason: result.code === 'cancelled'
              ? 'replacement-cancelled'
              : 'restore-start-failed',
            durationMs: performance.now() - startedAt,
          },
        )
        return
      }
      this.lifecycle.session(
        'replacement.rollback.end',
        handoff.predecessorSessionId,
        {
          kind: 'codex',
          predecessorSessionId: handoff.predecessorSessionId,
          ok: true,
          reason: 'successor-start-failed',
          durationMs: performance.now() - startedAt,
        },
      )
    } catch (restoreError) {
      // Never mask the successor failure the renderer/action is already
      // handling. The lifecycle outcome and internal error retain the separate
      // fact that compensation failed; the rollout coordinator remains
      // fail-closed if predecessor teardown was physically uncertain.
      performanceService.error(
        'session.spawn.codexReplacementRollback.error',
        restoreError,
        { sessionId: handoff.predecessorSessionId, kind: 'codex' },
      )
      this.lifecycle.session(
        'replacement.rollback.end',
        handoff.predecessorSessionId,
        {
          kind: 'codex',
          predecessorSessionId: handoff.predecessorSessionId,
          ok: false,
          reason: 'restore-start-failed',
          durationMs: performance.now() - startedAt,
        },
      )
    }
  }

  /**
   * Start a backend under an already-owned local routing id.
   *
   * WHY this is private: accepting a caller-selected id on the ordinary spawn
   * IPC made it possible for renderer code to recreate the exact check-then-
   * spawn race that recover() exists to close. Only recover() may reach this
   * method, after it has synchronously published the ownership claim that all
   * compatible callers join and kill() can cancel. Fresh panes always receive
   * a random id through spawn().
   */
  private async spawnWithId(
    options: SessionSpawnOptions,
    sessionId: string,
    recoveryClaim?: RecoveryClaim,
    codexReplacementHandoff?: CodexReplacementHandoff | null,
  ): Promise<SessionSpawnResult> {
    const requestedKind: unknown = options.kind
    if (requestedKind !== undefined && !isSessionKind(requestedKind)) {
      throw new Error('Unsupported session provider')
    }
    const kind: SessionKind = options.kind ?? DEFAULT_PROVIDER
    if (
      this.sessions.has(sessionId) ||
      this.spawningSessionGenerations.has(sessionId) ||
      this.promptDeliveriesInFlight.has(sessionId)
    ) {
      throw new Error(`Session ${sessionId} is already live`)
    }
    // WHY reserve before any provider/tmux await: restored sessions can be
    // woken by attach, send, and orchestration at almost the same time. The
    // renderer single-flights the common path, but main still has to defend the
    // invariant because IPC callers are not all in the same React closure. The
    // terminal tmux path awaited sessionExists/createSession before registering
    // the RegistryEntry, which left a small duplicate-spawn window during
    // restart wake. This reservation makes "spawning" observable to every
    // concurrent caller without pretending the backend is ready yet.
    const spawnGeneration = Symbol(sessionId)
    this.spawningSessionGenerations.set(sessionId, spawnGeneration)
    this.sessionStateGenerations.set(sessionId, spawnGeneration)
    if (recoveryClaim) recoveryClaim.spawnGeneration = spawnGeneration
    this.spawnInfo.set(sessionId, {
      kind,
      cwd: path.resolve(options.cwd),
      resumeSessionId: options.resumeSessionId ?? null,
      dangerousMode: options.dangerousMode === true,
      useProxy: options.useProxy === true,
    })
    // Record even a startup attempt before readiness creates its watermark.
    // Otherwise repeated pre-provider failures would populate the watermark
    // map without participating in the manager's existing bounded-id eviction.
    this.rememberSessionId(sessionId)
    // WHY main publishes starting before provider construction: every provider
    // should also report its more specific bootstrap phase, but ownership must
    // remain safe even if a provider regresses and omits that event. This also
    // advances the stable-id revision before a replacement process can emit
    // anything, so an old renderer fact can never outrank the new generation.
    this.setInputReadiness(sessionId, { ready: false, reason: 'starting' })
    let entry: RegistryEntry | null = null
    let mcpRegistered = false
    let createdTmuxName: string | null = null
    try {
    this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
    const spawnStartedAt = performance.now()
    performanceService.mark('session.spawn.start', {
      sessionId,
      kind,
      resume: Boolean(options.resumeSessionId),
      useProxy: Boolean(options.useProxy),
    })

    // Agent providers (claude, codex) — dispatched through the registry.
    // Both providers emit the same event shape (started, pty-data,
    // screen, jsonl-entry, jsonl-error, exit), so the wiring is
    // identical. The registry handles which concrete session class to
    // instantiate. This eliminates the if/else duplication that caused
    // cross-provider breakage when editing one provider's spawn logic.
    // isAgentProviderKind, not a literal pair: this is the agent-vs-
    // terminal spawn dispatch. With the literal pair, a registered
    // third provider silently fell through and spawned a PLAIN SHELL
    // (#394 §4.1 — the worst of the silent failure modes).
    if (isAgentProviderKind(kind)) {
      // Resolve the provider CLI to an ABSOLUTE path, or fail the spawn
      // right here — before any session-scoped state (MCP registration,
      // registry rows, proxy servers) exists (#495 A9). The old
      // `getToolPath(kind, kind)` fell back to the bare literal ('claude'
      // /'codex') when setup.json had no cached path; node-pty then
      // PATH-resolves it at exec time, and on a Finder-launched app with
      // launchd's minimal PATH that dies as exit-127 INSIDE the PTY —
      // where it reads like a provider crash, not a lookup failure — and
      // (Claude) the already-started mitmproxy leaked. Failing at create
      // time instead surfaces through session:spawn's reject, which the
      // renderer already renders via sessionSpawnErrorMessage.
      let binary = getToolPath(kind, '')
      if (!binary) {
        // One late re-resolve before giving up: launch-from-Finder rescue
        // for the user who installed the CLI after the setup gate ran.
        // Persist a hit through the same updateToolPaths →
        // refreshToolchainFromState pair the setup gate uses so the next
        // spawn takes the fast cache path and PATH augmentation applies.
        const resolved = await resolveToolPath(kind)
        this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
        if (resolved) {
          await updateToolPaths({ [kind]: resolved })
          this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
          await refreshToolchainFromState()
          this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
          binary = resolved
        }
      }
      if (!binary) {
        throw new Error(`${kind} CLI not found — open Setup to locate it`)
      }
      const initialSize = {
        cols: options.cols ?? 120,
        rows: options.rows ?? 40,
      }
      let builtInMcpServers: BuiltInMcpServerConfig[] = []
      if (options.builtInMcpDomains && options.builtInMcpDomains.length > 0) {
        if (!this.builtInMcpHost) {
          throw new Error('Built-in MCP host is not available')
        }
        builtInMcpServers = this.builtInMcpHost.registerSession({
          sessionId,
          cwd: options.cwd,
          providerKind: kind,
          domains: options.builtInMcpDomains,
        })
        mcpRegistered = true
      }
      this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
      if (this.beforeAgentSessionStart) {
        try {
          // Conventions reconciliation is a best-effort compatibility boundary,
          // never a reason to strand a requested agent launch. The service
          // records degraded/conflict health for Settings; the manager preserves
          // its older availability contract even if external storage is broken.
          await this.beforeAgentSessionStart()
        } catch (error) {
          this.journal?.recordError('conventions.pre_spawn_reconcile.error', error)
        }
        this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
      }
      const provider = getMainProvider(kind)
      const createStartedAt = performance.now()
      // `session` here structurally conforms to AgentSessionLike —
      // every provider that registers through the registry is
      // contracted to expose start/stop/write/resize + the standard
      // 'started'/'pty-data'/'screen'/'jsonl-entry'/'jsonl-error'/
      // 'process-state'/'conditions'/'semantic-event'/'exit' events. We use
      // a narrow structural cast so provider-specific implementation
      // details don't leak into the manager.
      const session = provider.createSession({
        cwd: options.cwd,
        binary,
        cols: initialSize.cols,
        rows: initialSize.rows,
        // 100ms (~10Hz), NOT the old 16ms (~60Hz). The 'screen'
        // snapshot pipeline is a parsing/monitoring surface, not a
        // display path — the visible terminal renders from raw
        // pty-data. At 16ms every live session built four buffer
        // serializations per tick (two of them per-cell markdown
        // walks over ~200 rows), ran all screen parsers, and shipped
        // four strings over IPC; with ~10 concurrent sessions that
        // allocated hundreds of MB/s of garbage in main and the V8
        // major-GC storm pinned ~80% CPU with heapUsed oscillating
        // 46MB↔1.2GB (#390 has the full trace-driven diagnosis).
        //
        // Kept EXPLICIT (not omitted) deliberately: the pinned
        // headless submodule commits still default to 16 internally
        // until the pointer bumps for claude-code-headless#32 /
        // codex-headless#24 land, and an explicit value here keeps
        // the app-side cadence independent of which submodule
        // revision is checked out. Those PRs also add a change gate
        // that skips identical frames entirely — the two fixes
        // compose.
        snapshotIntervalMs: 100,
        resumeSessionId: options.resumeSessionId,
        dangerousMode: options.dangerousMode,
        shellSessionId: sessionId,
        // Agent providers both accept `useProxy`. Claude uses the
        // mitmproxy path; Codex uses a local Responses proxy via
        // `openai_base_url`.
        useProxy: options.useProxy,
        builtInMcpServers,
        ...(kind === 'codex' && codexReplacementHandoff
          ? {
              // WHY the provider receives execution timing, not policy: Codex
              // knows the final safe point before exact transcript ownership;
              // SessionManager alone knows which local predecessor was proven
              // and how to compensate it. The closure keeps that dependency
              // arrow one-way and is absent from every ordinary spawn.
              beforeResumeOwnershipAcquire: () =>
                this.executeCodexReplacementHandoff(
                  codexReplacementHandoff,
                  sessionId,
                ),
            }
          : {}),
      })
      const agentEntry: RegistryEntry = {
        kind,
        session,
        lifecycle: createRegistryLifecycle(spawnGeneration),
      }
      entry = agentEntry
      const ownsEntry = (): boolean => this.sessions.get(sessionId) === agentEntry
      this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
      // No cast: createSession's return type is now AgentSession, so
      // any provider whose runtime drifts from the contract fails
      // compilation inside the provider (registry.main.ts's
      // Record<AgentProviderKind, MainProviderConfig> forces it). See
      // #394 phase 2a.
      performanceService.record({
        kind: 'span_end',
        process: 'main',
        area: 'session.spawn',
        name: 'session.spawn.providerCreate',
        durationMs: performance.now() - createStartedAt,
        sessionId,
        provider: kind,
      })

      this.sessionSizes.set(sessionId, initialSize)
      this.agentPtyBuffers.set(sessionId, new CappedTextBuffer(AGENT_PTY_BUFFER_CAP))
      session.on('started', ({ projectDir }) => {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        this.emit('started', {
          sessionId,
          sessionRunId: agentEntry.lifecycle.runId,
          kind,
          projectDir,
        })
      })
      session.on('input-readiness', (input: AgentInputReadiness) => {
        if (!ownsEntry()) return
        this.setInputReadiness(sessionId, input)
      })
      // The RICH stall reason, and the reason this listener exists at all.
      //
      // `publishPromptGate` collapses its detailed verdict into an
      // input-readiness event carrying only 'ready' | 'provider-not-ready', so
      // by the time readiness reaches main the distinction between "replaying
      // history", "the composer never painted", and "a human has a draft in the
      // box" is already gone. Those are three completely different problems and
      // they are indistinguishable in every log we have today.
      //
      // Only Claude emits this; Codex and opencode latch a coarse boolean. That
      // asymmetry is itself worth recording rather than papering over — see
      // `sampleStalledGates` for the provider-agnostic duration signal.
      //
      // Nothing here changes gate behaviour. This is a listener on an event the
      // provider already emitted.
      session.on('prompt-gate', (gate: PromptGateState) => {
        if (!ownsEntry()) return
        this.noteGateEvaluation(sessionId, kind, gate)
      })
      session.on('pty-data', (data: string) => {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        let replay = this.agentPtyBuffers.get(sessionId)
        if (!replay) {
          replay = new CappedTextBuffer(AGENT_PTY_BUFFER_CAP)
          this.agentPtyBuffers.set(sessionId, replay)
        }
        replay.append(data)
        if ((this.agentPtyAttachCounts.get(sessionId) ?? 0) > 0) {
          this.emit('agent-pty-data', { sessionId, data })
        }
        this.emit('pty-data', { sessionId, data })
      })
      session.on('screen', (snap: AgentScreenSnapshot) => {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        this.lastScreenSnapshot.set(sessionId, snap)
        this.emit('screen', { sessionId, ...snap })
      })
      session.on('jsonl-entry', (
        entry: AgentTranscriptEntry,
        file: string,
        observation?: AgentTranscriptObservationMetadata,
      ) => {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        this.lastTranscriptFile.set(sessionId, file)
        if (kind === 'codex' && observation) {
          const rollout = entry && typeof entry === 'object'
            ? entry as unknown as Record<string, unknown>
            : null
          const isSessionMeta = rollout?.type === 'session_meta'
          const providerSessionMetaFingerprint = isSessionMeta
            ? pickLifecycleCorrelationIds({
                providerSessionMetaFingerprint:
                  observation.providerSessionMetaFingerprint,
              })?.providerSessionMetaFingerprint
            : undefined
          if (isSessionMeta) {
            // WHY only session_meta is journalled here: rollout-entry is a hot
            // path (thousands of rows in a long turn) and the raw committed
            // feed already reaches the renderer with its observation sidecar.
            // Per-entry app-journal rows can overflow the 2k pending cap before
            // an incident flush, destroying the much rarer submit/reconcile
            // rows. session_meta is one sparse committed fact per generation
            // and supplies the exact provider identity needed to compare with
            // x-codex-window-id without retaining transcript content or paths.
            // A malformed/future payload still gets a structural row with an
            // explicit false validity bit: silence here would make provider
            // shape drift indistinguishable from a missing tail callback.
            const fileGenerationId = observation.fileGenerationId ?? undefined
            this.recordCodexTranscriptObservation('transcript.entry', sessionId, {
              source: 'session-meta',
              entryByteOffset: observation.rolloutByteOffset,
              attached: true,
              tailing: true,
              providerSessionMetaValid:
                providerSessionMetaFingerprint !== undefined,
            }, {
              ...(providerSessionMetaFingerprint
                ? { providerSessionMetaFingerprint }
                : {}),
              ...(fileGenerationId ? { fileGenerationId } : {}),
              ...(fileGenerationId
                ? { rolloutEntryId: `${fileGenerationId}:${observation.rolloutByteOffset}` }
                : {}),
            }, agentEntry.lifecycle.runId)
          }
        }
        // Observation precedes the externally-observable emit. EventEmitter
        // listeners run synchronously and may retire this pane; recording after
        // emit either lost A's source fact or re-stamped it as replacement B.
        this.emit('jsonl-entry', { sessionId, entry, file, observation })
      })
      session.on('jsonl-error', (error: Error) => {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        if (kind === 'codex') {
          const message = String(error?.message ?? error)
          const capabilityRefusal = message.includes('Codex prompt evidence disabled:')
          this.recordCodexTranscriptObservation('transcript.attachment', sessionId, {
            decision: 'error',
            reason: capabilityRefusal ? 'prompt-evidence-disabled' : 'jsonl-error',
            code: capabilityRefusal && message.includes('unsupported-cli')
              ? 'unsupported-cli'
              : 'unknown',
            attached: false,
            tailing: false,
          }, undefined, agentEntry.lifecycle.runId)
        }
        this.emit('jsonl-error', { sessionId, error })
      })
      session.on('transcript-diagnostic', (diagnostic: unknown) => {
        if (!ownsEntry()) return
        if (kind === 'codex' && this.observeCodexTranscriptDiagnostic(
          sessionId,
          diagnostic,
          agentEntry.lifecycle.runId,
        )) {
          // Provider-request rows are main-only Stage 0 evidence. Sending this
          // wrapper through session:transcript-diagnostic would not affect the
          // semantic reducer today, but it would create a second product-facing
          // route future code could accidentally treat as policy.
          return
        }
        this.emit('transcript-diagnostic', { sessionId, diagnostic })
      })
      session.on('process-state', (state: AgentProcessState) => {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        this.emit('process-state', { sessionId, ...state })
      })
      session.on('trust-dialog', (state: AgentTrustDialogState) => {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        this.emit('trust-dialog', { sessionId, ...state })
      })
      session.on('resume-prompt', (state: AgentResumePromptState) => {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        this.emit('resume-prompt', { sessionId, ...state })
      })
      session.on('permission-prompt', (state: AgentPermissionPromptState) => {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        this.emit('permission-prompt', { sessionId, ...state })
      })
      session.on('conditions', (snapshot: ProviderConditionSnapshot) => {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        this.lastConditionsSnapshot.set(sessionId, snapshot)
        this.emit('conditions', { sessionId, snapshot })
      })
      session.on('semantic-event', (event: unknown) => {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        if (kind === 'codex') {
          this.observeCodexSemanticEvent(sessionId, event, agentEntry.lifecycle.runId)
        }
        this.emit('semantic-event', { sessionId, event })
      })
      session.on('exit', ({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        if (!ownsEntry()) return
        // WHY this marker precedes registry cleanup: replacement admission may
        // have captured this exact generation while successor preflight was
        // awaiting. Once cleanup removes the row, only the captured lifecycle
        // can distinguish natural provider death from an explicit close (whose
        // kill path removes listeners before stop and therefore cannot set it).
        agentEntry.lifecycle.naturalExitObserved = true
        this.markActivity(sessionId)
        this.setInputReadiness(sessionId, {
          ready: false,
          reason: 'provider-not-ready',
        })
        this.emit('removed', { sessionId })
        this.emit('exit', { sessionId, exitCode, signal })
        this.cleanupSessionState(sessionId, kind, agentEntry)
      })

      this.sessions.set(sessionId, agentEntry)
      if (kind === 'codex') {
        this.rememberCodexSessionRun(sessionId, agentEntry.lifecycle.runId, 'live')
      }
      // Clear any gate state left by a PREVIOUS backend under this same local
      // id. Stable ids are deliberately reused after a failed start, and
      // cleanupSessionState is generation-owned — it returns early for a
      // superseded entry, so relying on teardown alone let a fresh backend
      // inherit the dead one's `since` (fabricating elapsed) and, because the
      // first verdict then looked unchanged, skip arming the sampler entirely.
      this.lastGateEvaluation.delete(sessionId)
      this.rememberSessionId(sessionId)
      this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
      // Hoisted out of the try so the catch can report a duration too: a
      // provider that throws after 90 seconds and one that throws instantly are
      // completely different failures, and the old code could not tell them
      // apart because this was scoped to the success path.
      const startStartedAt = performance.now()
      try {
        // WHY this duplicates the performanceService span below: that span is
        // gated behind AGENT_CODE_PERF, which is off by default — which is
        // precisely why "the agent takes minutes to start" has never had a
        // measurement attached to it. This pair is always on. The perf span
        // stays for its richer sampling when someone deliberately enables it.
        this.lifecycle.session('provider.start.begin', sessionId, { kind })
        await session.start()
        await this.settleEntryStart(sessionId, agentEntry)
        this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
        if (!ownsEntry()) throw new RecoveryCancelledError()
        this.lifecycle.session('provider.start.end', sessionId, {
          kind,
          ok: true,
          durationMs: performance.now() - startStartedAt,
        })
        performanceService.record({
          kind: 'span_end',
          process: 'main',
          area: 'session.spawn',
          name: 'session.spawn.providerStart',
          durationMs: performance.now() - startStartedAt,
          sessionId,
          provider: kind,
        })
      } catch (err) {
        await this.settleEntryStart(sessionId, agentEntry)
        this.lifecycle.session('provider.start.end', sessionId, {
          kind,
          ok: false,
          durationMs: performance.now() - startStartedAt,
        })
        performanceService.error('session.spawn.providerStart.error', err, {
          sessionId,
          kind,
        })
        throw err
      }
      performanceService.record({
        kind: 'span_end',
        process: 'main',
        area: 'session.spawn',
        name: 'session.spawn.total',
        durationMs: performance.now() - spawnStartedAt,
        sessionId,
        provider: kind,
      })
      return { sessionId }
    }

    // kind === 'terminal'
    //
    // Tmux backing is opt-in based on registry availability. When the
    // registry says yes, we either reuse an existing tmux session
    // (recovery path — `recoverTmuxName` was passed and the session
    // is alive) or create a fresh one. When tmux is unavailable, fall
    // through to the direct PTY path that's existed since day one.
    const useTmux = this.tmuxRegistry?.isAvailable() === true
    let tmuxSessionName: string | null = null
    if (useTmux) {
      const tmuxStartedAt = performance.now()
      const reg = this.tmuxRegistry!
      const recoveredTmux = options.recoverTmuxName
        ? await reg.sessionExists(options.recoverTmuxName)
        : false
      this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
      if (options.recoverTmuxName && recoveredTmux) {
        // Reattach path — tmux owned this session through the previous
        // Agent Code launch and it's still alive. Reuse the name; do
        // NOT createSession (that would error or duplicate).
        tmuxSessionName = options.recoverTmuxName
      } else {
        tmuxSessionName = reg.generateName()
        await reg.createSession({
          name: tmuxSessionName,
          // pickShell, not the old bare `process.env.SHELL ?? '/bin/zsh'`:
          // this was the second copy of the shell-selection expression and
          // the tmux path had the SAME missing existence check as
          // TerminalSession (#495 A8) — a stale $SHELL made the tmux
          // session's command unspawnable, which surfaces as tmux exiting
          // immediately on attach. One probed chain for both spawn paths.
          command: pickShell(),
          cwd: options.cwd,
        })
        createdTmuxName = tmuxSessionName
        this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
      }
      performanceService.record({
        kind: 'span_end',
        process: 'main',
        area: 'session.spawn',
        name: 'session.spawn.tmuxPrepare',
        durationMs: performance.now() - tmuxStartedAt,
        sessionId,
        provider: 'terminal',
        data: { recovered: recoveredTmux },
      })
    }

    const initialSize = {
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    }

    // WHY we thread the registry's binary through to TerminalSession:
    //   TerminalSession's tmux runtime spawns `tmux attach -t <name>`,
    //   so it needs to point at the SAME binary the registry just
    //   used to `new-session` the target. Under the bundled-only
    //   policy (see src/main/index.ts), PATH-resolved `tmux` could be
    //   a different version with an incompatible session format —
    //   using one tmux to create and another to attach would
    //   silently fail or, worse, partially work. The registry is the
    //   source of truth.
    //
    //   When useTmux is true the registry must have a binary (the
    //   `isAvailable()` gate above only flips true after
    //   `detectAvailability()` confirmed one), so the null coalesce
    //   below is defensive against future code paths that bypass
    //   that gate.
    const registryBinary = this.tmuxRegistry?.getBinary() ?? undefined
    const session = new TerminalSession({
      cwd: options.cwd,
      cols: initialSize.cols,
      rows: initialSize.rows,
      runtime: useTmux ? 'tmux' : 'direct',
      tmuxSessionName: tmuxSessionName ?? undefined,
      tmuxBinary: useTmux ? registryBinary : undefined,
    })
    const terminalEntry: RegistryEntry = {
      kind: 'terminal',
      session,
      tmuxName: tmuxSessionName,
      lifecycle: createRegistryLifecycle(spawnGeneration),
    }
    entry = terminalEntry
    const ownsEntry = (): boolean => this.sessions.get(sessionId) === terminalEntry
    this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)

    // Initialize an empty buffer entry NOW, before start() fires any
    // data events. The buffer accumulates every byte of PTY output
    // and is replayed to the renderer on attach — see the block
    // comment on terminalBuffers above for the full reasoning.
    this.sessionSizes.set(sessionId, initialSize)
    this.terminalBuffers.set(sessionId, new CappedTextBuffer(TERMINAL_BUFFER_CAP))

    // Terminal sessions only emit started / data / exit. The 'data'
    // event carries raw PTY bytes for xterm.js on the renderer side;
    // we forward it on a dedicated 'terminal-data' channel so the
    // renderer can route it straight to xterm without the code path
    // for Claude's structured events getting involved.
    session.on('started', () =>
      {
        if (!ownsEntry()) return
        this.markActivity(sessionId)
        this.emit('started', {
          sessionId,
          sessionRunId: terminalEntry.lifecycle.runId,
          kind,
          projectDir: undefined,
        })
      },
    )
    session.on('data', data => {
      if (!ownsEntry()) return
      this.markActivity(sessionId)
      // Always append to the rolling buffer so a later attach can
      // replay the full history. Cap at TERMINAL_BUFFER_CAP —
      // longer sessions just lose the oldest bytes, which is the
      // standard terminal scrollback behavior.
      let replay = this.terminalBuffers.get(sessionId)
      if (!replay) {
        replay = new CappedTextBuffer(TERMINAL_BUFFER_CAP)
        this.terminalBuffers.set(sessionId, replay)
      }
      replay.append(data)
      // Only broadcast live events AFTER the renderer has attached.
      // Before attach, the data is still in the buffer and will be
      // replayed when the renderer calls attachTerminal. See the
      // block comment on terminalBuffers for why this is
      // race-free.
      if (this.terminalAttached.has(sessionId)) {
        this.emit('terminal-data', { sessionId, data })
      }
    })
    session.on('exit', ({ exitCode, signal }) => {
      if (!ownsEntry()) return
      terminalEntry.lifecycle.naturalExitObserved = true
      this.markActivity(sessionId)
      this.setInputReadiness(sessionId, {
        ready: false,
        reason: 'provider-not-ready',
      })
      this.emit('removed', { sessionId })
      this.emit('exit', { sessionId, exitCode, signal })
      this.cleanupSessionState(sessionId, 'terminal', terminalEntry)
    })

    this.sessions.set(sessionId, terminalEntry)
    this.rememberSessionId(sessionId)
    this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
    try {
      const terminalStartStartedAt = performance.now()
      await session.start()
      await this.settleEntryStart(sessionId, terminalEntry)
      this.throwIfSpawnCancelled(recoveryClaim, codexReplacementHandoff)
      if (!ownsEntry()) throw new RecoveryCancelledError()
      this.setInputReadiness(sessionId, {
        ready: true,
        reason: 'ready',
      })
      performanceService.record({
        kind: 'span_end',
        process: 'main',
        area: 'session.spawn',
        name: 'session.spawn.terminalStart',
        durationMs: performance.now() - terminalStartStartedAt,
        sessionId,
        provider: 'terminal',
      })
    } catch (err) {
      // start() can fail if the PTY refuses to spawn or (on the tmux
      // path) the tmux server dies between createSession and attach.
      // Without cleanup here, the terminalBuffers entry we set up
      // pre-start stays forever (no 'exit' event will fire for a
      // session that never started), and the registry row points at
      // a half-dead TerminalSession that callers might still try to
      // write()/resize()/kill(). Roll back everything we added in
      // THIS spawn so the caller can retry from a clean slate.
      await this.settleEntryStart(sessionId, terminalEntry)
      performanceService.error('session.spawn.terminalStart.error', err, { sessionId })
      throw err
    }
    performanceService.record({
      kind: 'span_end',
      process: 'main',
      area: 'session.spawn',
      name: 'session.spawn.total',
      durationMs: performance.now() - spawnStartedAt,
      sessionId,
      provider: 'terminal',
    })
    return { sessionId, tmuxName: tmuxSessionName ?? undefined }
    } catch (error) {
      // WHY spawn is one transaction across provider construction, MCP
      // registration, registry publication, and start(): failures can occur at
      // every boundary, including cancellation while start() is still pending.
      // Rolling back only the map that happened to be nearest the throw left
      // half-live providers, writable registry entries, and newly-created tmux
      // servers behind. The exact RegistryEntry is the transaction token: it
      // lets this generation clean itself up without ever deleting a newer
      // replacement that reused the stable renderer id.
      if (entry) {
        await this.settleEntryStart(sessionId, entry)
        await this.requestEntryStop(sessionId, entry)
        this.removeEntryListeners(entry)
        if (this.sessions.get(sessionId) === entry) {
          this.emit('removed', { sessionId })
          this.cleanupSessionState(sessionId, kind, entry, mcpRegistered)
        }
      } else {
        // Construction can fail after session-scoped MCP registration but
        // before a wrapper exists. There is nothing to stop, yet those
        // pre-entry maps and credentials still belong to this attempt.
        this.cleanupSessionState(
          sessionId,
          kind,
          undefined,
          mcpRegistered,
          spawnGeneration,
        )
      }

      if (createdTmuxName && this.tmuxRegistry) {
        // Recovered tmux sessions are durable user state and must survive a
        // failed attach. Only a server created by this transaction is safe to
        // destroy here.
        try {
          await this.tmuxRegistry.killSession(createdTmuxName)
        } catch (tmuxError) {
          performanceService.error('session.spawn.tmuxRollback.error', tmuxError, {
            sessionId,
            kind,
          })
        }
      }
      throw error
    } finally {
      if (this.spawningSessionGenerations.get(sessionId) === spawnGeneration) {
        this.spawningSessionGenerations.delete(sessionId)
      }
    }
  }

  /**
   * Terminal attach/replay entry point.
   *
   * Called by the renderer when a TerminalLeaf mounts and wants to
   * hook up its xterm.js instance to an already-running terminal
   * session. Returns the current output buffer AND flips the
   * attached flag, both synchronously in the same tick so no PTY
   * data can slip between the two operations.
   *
   * Usage from the renderer (see TerminalLeaf.tsx):
   *   1. Subscribe to 'session:terminal-data' first so no events
   *      after attach are missed.
   *   2. Call attachTerminal(sessionId); write returned buffer to
   *      xterm. Any live events that arrived between subscribe and
   *      this point must be queued and written AFTER the buffer —
   *      see the queue logic in TerminalLeaf.
   *   3. Subsequent live events write directly to xterm.
   *
   * Returns '' if the session doesn't exist or isn't a terminal —
   * silently safe so a stale attach call on a dead session doesn't
   * error.
   */
  attachTerminal(sessionId: string): string {
    const entry = this.sessions.get(sessionId)
    if (!entry) {
      // Caller is asking to attach to a session that's already gone.
      // Silent empty-string is fine here; any TerminalLeaf that mounts
      // for a dead session will simply see an empty xterm.
      return ''
    }
    if (entry.kind !== 'terminal') {
      // Kind mismatch is a routing bug — a Claude or Codex pane's
      // leaf is wiring itself into the terminal-data pipeline. Keep
      // returning '' (don't crash the renderer over an assumption
      // mismatch) but warn loudly so the caller sees it in the main
      // process log instead of silently losing data. Without this
      // warn, a regression that sent a terminal attach call to the
      // wrong pane would look like "nothing renders" with no trace.
      console.warn(
        `[SessionManager] attachTerminal called on non-terminal session`,
        { sessionId, kind: entry.kind },
      )
      return ''
    }
    const buffer = this.terminalBuffers.get(sessionId)?.read() ?? ''
    // Flip the attach flag in the SAME synchronous block as reading
    // the buffer. JavaScript is single-threaded and event emission
    // can only happen on a later tick, so nothing can sneak in.
    this.terminalAttached.add(sessionId)
    return buffer
  }

  /**
   * Agent PTY attach/replay entry point.
   *
   * This is the Claude/Codex counterpart to attachTerminal(). It is
   * intentionally separate because agent panes are not terminal panes:
   * their primary renderer is the structured feed, while this inline
   * terminal is an opt-in view into the underlying provider TUI.
   * Returning the buffered raw bytes lets the inline xterm reconstruct
   * the provider's latest terminal state, then `agent-pty-data`
   * carries subsequent live bytes for as long as the session remains
   * open.
   *
   * Multiple renderer consumers can attach to the same session (for example a
   * debug panel plus a Tiled Dispatch lane). The attach count is intentionally
   * session-scoped: the first attach captures the provider PTY size to restore
   * later, and the final detach performs that restore. This prevents one
   * unmounted consumer from cutting off live bytes for another still-mounted
   * raw terminal.
   */
  /**
   * Returns the replay buffer on success, or NULL when there is nothing to
   * attach to. The null/'' distinction is load-bearing: '' is a legitimate
   * result (a freshly spawned agent that has not emitted a byte yet) and DOES
   * hold a reference, while null means no reference was taken and the caller
   * may safely attach again later. Returning '' for both made "the backend
   * does not exist" indistinguishable from "it exists and is quiet", so a
   * caller could neither retry (risking a double-increment and a leaked
   * reference) nor report the failure — it just rendered a blank terminal
   * that silently swallowed keystrokes.
   */
  attachAgentPty(sessionId: string): string | null {
    const entry = this.sessions.get(sessionId)
    if (!entry) return null
    if (!isAgentProviderKind(entry.kind)) {
      console.warn(
        `[SessionManager] attachAgentPty called on non-agent session`,
        { sessionId, kind: entry.kind },
      )
      return null
    }
    const buffer = this.agentPtyBuffers.get(sessionId)?.read() ?? ''
    const attachCount = this.agentPtyAttachCounts.get(sessionId) ?? 0
    if (attachCount === 0) {
      const currentSize = this.sessionSizes.get(sessionId)
      if (currentSize) {
        this.agentPtyRestoreSizes.set(sessionId, { ...currentSize })
      }
    }
    this.agentPtyAttachCounts.set(sessionId, attachCount + 1)
    return buffer
  }

  /**
   * Detach a raw inline terminal from a Claude/Codex session.
   * The final detach disables raw PTY IPC forwarding and restores the provider
   * PTY size that was active before the first inline terminal took ownership.
   */
  detachAgentPty(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    const attachCount = this.agentPtyAttachCounts.get(sessionId) ?? 0
    if (attachCount > 1) {
      this.agentPtyAttachCounts.set(sessionId, attachCount - 1)
      return
    }
    this.agentPtyAttachCounts.delete(sessionId)
    const restoreSize = this.agentPtyRestoreSizes.get(sessionId)
    this.agentPtyRestoreSizes.delete(sessionId)
    if (!entry || !isAgentProviderKind(entry.kind)) return
    if (!restoreSize) return
    entry.session.resize(restoreSize.cols, restoreSize.rows)
    this.sessionSizes.set(sessionId, restoreSize)
  }

  /**
   * Write bytes to a session's PTY. Silently no-ops if the session
   * doesn't exist — this happens naturally if a session exits between
   * the renderer queueing input and the main process handling it.
   */
  /**
   * Whether a provider prompt delivery currently holds this session's write
   * reservation. Exposed so the IPC layer can report WHY a write was dropped
   * instead of guessing — see the session:input handler.
   */
  isDeliveryInFlight(sessionId: string): boolean {
    return this.promptDeliveriesInFlight.has(sessionId)
  }

  /**
   * Record who wrote into the provider's composer.
   *
   * WHY this exists at all: the prompt gate refuses delivery while the composer
   * holds a draft, and it decides that by classifying rendered characters. That
   * can tell us characters are present; it cannot tell us who put them there.
   * A human mid-sentence, a dictation paste, the phone client, a debug
   * terminal, and a delivery that stranded its own bytes all render identically
   * and all produce `occupied / human-draft`. Sessions then sit blocked — 19 of
   * 216 ended that way, the longest for 47 hours — with the cause unknowable
   * after the fact.
   *
   * WHY here and not at the call sites: this is the single function every
   * non-delivery writer reaches (renderer composer, raw terminal view, terminal
   * panes, dictation, debug terminal, phone client). Instrumenting the choke
   * point cannot miss a writer; instrumenting seven call sites can, and would
   * miss the eighth one added later.
   *
   * WHY coalesced rather than one event per write: a raw terminal view sends
   * one write per keystroke. Logging each would bury the signal in the journal
   * that exists to surface it, and would make the journal's own size a new
   * problem. One event per session per window, carrying the count, answers
   * "did someone type here, and when" — which is the question — without
   * carrying what they typed, which is never logged.
   */
  private recordInputWrite(
    sessionId: string,
    data: string,
    origin: InputWriteOrigin,
  ): void {
    if (!this.lifecycle) return
    const now = Date.now()
    const pending = this.inputWriteCoalesce.get(sessionId)
    // A submit is always worth its own event: it is the boundary between "text
    // is accumulating" and "the composer should now be empty", which is exactly
    // the transition that matters when reconstructing why a composer is
    // occupied later.
    const hasSubmit = data.includes('\r')
    if (pending && !hasSubmit && now - pending.firstAt < INPUT_WRITE_COALESCE_MS && pending.origin === origin) {
      pending.writes += 1
      pending.bytes += data.length
      return
    }
    if (pending) this.flushInputWrite(sessionId)
    const entry = {
      firstAt: now, writes: 1, bytes: data.length, origin, hadSubmit: hasSubmit,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }
    this.inputWriteCoalesce.set(sessionId, entry)
    if (hasSubmit) this.flushInputWrite(sessionId)
    else {
      entry.timer = setTimeout(() => this.flushInputWrite(sessionId), INPUT_WRITE_COALESCE_MS)
      // Never hold the process open for a diagnostic.
      entry.timer.unref?.()
    }
  }

  private flushInputWrite(sessionId: string): void {
    const pending = this.inputWriteCoalesce.get(sessionId)
    if (!pending) return
    this.inputWriteCoalesce.delete(sessionId)
    // A flush can be reached before the window elapses — by a submit, an origin
    // change, or teardown — so the timer is cleared here rather than only on
    // the path that owns it.
    if (pending.timer) clearTimeout(pending.timer)
    // Byte COUNTS only. What the user typed is never journaled — the question
    // is who wrote and when, and the content would make this a privacy problem
    // for no diagnostic gain.
    this.lifecycle?.session('input.write', sessionId, {
      origin: pending.origin,
      writes: pending.writes,
      bytes: pending.bytes,
      hadSubmit: pending.hadSubmit,
      windowMs: Date.now() - pending.firstAt,
    })
  }

  write(
    sessionId: string,
    data: string,
    // Defaulted rather than required so no caller is forced to lie. A caller
    // that does not know its own origin gets the honest bucket instead of a
    // made-up label, and the two entry points that DO know pass it.
    origin: Exclude<InputWriteOrigin, 'delivery' | 'condition'> = 'renderer',
  ): boolean {
    // A raw Enter is globally meaningful to a TUI composer. While the provider
    // delivery state machine owns that composer, accepting Enter from a slash
    // path, remote submit, or raw terminal would let one operation submit
    // another's bytes. Provider-owned writes use writeReserved below.
    //
    // An earlier cut of this fix punched a hole here for "any active
    // condition", so a trust modal's keystrokes could reach the PTY while a
    // delivery held the reservation. It was reverted before merge for two
    // reasons worth recording, because the idea is tempting and wrong:
    //
    //   1. It read getConditionSnapshot() off the SESSION, which no session
    //      class implements (it lives on the headless), so it was inert in
    //      production. A structural cast hid that from tsc and the tests
    //      fabricated the method on hand-built stubs, so it went green.
    //   2. Had it worked, it admitted EVERY write — raw terminal typing,
    //      dictation, paste — not just condition keystrokes, and conditions
    //      that delivery itself triggers (the slash picker paints while
    //      delivery types) would have opened the gap mid-write, which is
    //      exactly the interleaving this guard exists to prevent.
    //
    // The right shape, if a net is ever wanted, is a dedicated
    // condition-resolution path that looks an action up in the live snapshot
    // and writes only that action's bytes, leaving this guard untouched.
    if (this.promptDeliveriesInFlight.has(sessionId)) return false
    const entry = this.sessions.get(sessionId)
    if (!entry) {
      // A silent miss here is brutal to debug from the renderer: the composer
      // clears, the feed may show an optimistic user row, and nothing ever
      // reaches the PTY. Surface the miss to callers so they can log/retain
      // the draft instead of pretending the send succeeded.
      //
      // This is also the durable signal for the "restored agents are null until
      // reload" bug (plan Phase 5): a renderer pane writing to a session id main
      // has no backend for. Journal the FIRST miss per id (coalesced) — but ONLY
      // when the id was NEVER owned. A miss on a once-owned id is the benign race
      // the docstring above describes (session exited between queue and write),
      // not the bug, so we stay silent for it to avoid crying wolf.
      if (
        this.journal &&
        !this.everKnownSessionIds.has(sessionId) &&
        !this.inputWriteFailedReported.has(sessionId)
      ) {
        this.inputWriteFailedReported.add(sessionId)
        if (this.inputWriteFailedReported.size > 256) this.inputWriteFailedReported.clear()
        this.journal.recordIncident({
          kind: 'session.input_write_failed',
          severity: 'error',
          reason: 'backend_session_not_found',
          context: { sessionId, dataLength: data.length },
        })
      }
      return false
    }
    // Recorded BEFORE crossing the write boundary, deliberately. node-pty's
    // write is not transactional: a throw does not prove zero bytes reached the
    // child. Recording after would drop exactly the writes most likely to
    // orphan a prompt — the ones that failed halfway — leaving the journal
    // silent about the case it exists to explain. So this event means "bytes
    // were handed to the PTY", not "the PTY accepted them", and the absence of
    // an event is the strong claim: nothing was even attempted.
    //
    // The origin the caller supplies is as precise as the boundary can be
    // without a contract change; see InputWriteOrigin.
    this.recordInputWrite(sessionId, data, origin)
    entry.session.write(data)
    return true
  }

  private writeReserved(
    sessionId: string,
    expectedEntry: RegistryEntry,
    data: string,
    onWriteAttempt?: () => void,
  ): boolean {
    if (this.sessions.get(sessionId) !== expectedEntry) return false
    // node-pty's write boundary is not transactional: an exception does not
    // prove zero bytes reached the child. Mark the stage immediately before
    // crossing it so the outer coordinator never labels a thrown write safe to
    // retry. The identity rejection above remains genuinely pre-write.
    onWriteAttempt?.()
    // Before the crossing, for the same reason as `onWriteAttempt` immediately
    // above: a thrown write may still have delivered bytes, and the journal has
    // to agree with the retry decision rather than contradict it.
    this.recordInputWrite(sessionId, data, 'delivery')
    expectedEntry.session.write(data)
    return true
  }

  getSessionKind(sessionId: string): SessionKind | null {
    return this.sessions.get(sessionId)?.kind ?? null
  }

  /**
   * Return the identity of the concrete backend currently owning a pane.
   *
   * This is intentionally read-only diagnostic metadata. Callers may attach
   * it to observations, but no lifecycle or transcript decision may branch on
   * it; the registry generation/entry identity remain the runtime authorities.
   */
  getSessionRunId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.lifecycle.runId ?? null
  }

  /**
   * Prove whether main has owned one exact Codex backend lifetime.
   *
   * WHY callers provide both ids: sessionId alone is durable renderer routing
   * identity and can name many successive processes. Returning only "this pane
   * used to be Codex" would recreate the same false join this accessor exists
   * to prevent. Live state is re-proven against the registry on every call;
   * only retired pairs may rely on the bounded recent-run ledger.
   */
  getCodexSessionRunState(
    sessionId: string,
    sessionRunId: string,
  ): CodexSessionRunState | null {
    const liveEntry = this.sessions.get(sessionId)
    if (
      liveEntry?.kind === 'codex' &&
      liveEntry.lifecycle.runId === sessionRunId
    ) return 'live'

    const known = this.recentCodexSessionRuns.get(
      this.codexSessionRunKey(sessionId, sessionRunId),
    )
    return known?.state === 'retired' ? 'retired' : null
  }

  /**
   * Record a content-safe fact about Codex transcript continuity.
   *
   * This is deliberately a write-only fan-out into the existing lifecycle
   * journal and an already-active session recorder. Nothing can query it, and
   * the method refuses non-Codex sessions, so instrumentation cannot become a
   * provider-neutral policy surface by accident.
   */
  recordCodexTranscriptObservation(
    name: CodexTranscriptObservationEventName,
    sessionId: string,
    data?: SessionLifecycleData,
    correlationIds?: SessionLifecycleCorrelationIds,
    expectedSessionRunId?: string,
  ): void {
    if (!isCodexTranscriptObservationEventName(name)) return
    // Product recovery may preserve legacy/malformed stable pane ids. Stage 0
    // is a shareable forensic stream, so fail only this observation fan-out
    // closed rather than serializing path/prompt-shaped scope text or changing
    // whether the underlying Codex session is allowed to run.
    if (!isCodexTranscriptObservationSessionId(sessionId)) return
    const liveEntry = this.sessions.get(sessionId)
    if (liveEntry?.kind !== 'codex') return
    const sessionRunId = liveEntry.lifecycle.runId
    // Provider callbacks capture the source run before crossing any external
    // EventEmitter boundary. Refuse the row if stable pane ownership changed;
    // a diagnostic gap is preferable to a false A-source/B-run join.
    if (expectedSessionRunId && sessionRunId !== expectedSessionRunId) return
    const safeData = pickCodexTranscriptObservationData(name, data)
    const safeCorrelationIds = pickCodexTranscriptObservationCorrelationIds(
      name,
      correlationIds,
      safeData,
    )
    const ids = {
      ...safeCorrelationIds,
      ...(sessionRunId ? { sessionRunId } : {}),
      sessionId,
    }
    this.lifecycle.record(name, ids, safeData)
    try {
      if (!sessionRunId) return
      this.recordCodexObservation(sessionId, sessionRunId, {
        schemaVersion: 1,
        name,
        ids,
        ...(safeData ? { data: safeData } : {}),
      })
    } catch {
      // The recorder is optional evidence. A closed/capped recorder must never
      // perturb provider event delivery or the main registry.
    }
  }

  private observeCodexSemanticEvent(
    sessionId: string,
    value: unknown,
    expectedSessionRunId: string,
  ): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const event = value as Record<string, unknown>
    const stringId = (key: string): string | undefined =>
      typeof event[key] === 'string' ? event[key] as string : undefined
    const type = stringId('type')

    if (type === 'turn_started') {
      this.recordCodexTranscriptObservation('semantic.turn', sessionId, {
        phase: 'started',
        source: codexObservationEnumOrUnknown('semantic.turn', 'source', event.source),
      }, {
        ...(stringId('requestId') ? { proxyRequestId: stringId('requestId') } : {}),
        ...(stringId('flowId') ? { proxyFlowId: stringId('flowId') } : {}),
        ...(stringId('turnId') ? { semanticTurnId: stringId('turnId') } : {}),
      }, expectedSessionRunId)
    }
  }

  private observeCodexProviderRequest(
    sessionId: string,
    value: unknown,
    expectedSessionRunId: string,
  ): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const event = value as Record<string, unknown>
    if (event.type !== 'provider_request') return
    const stringId = (key: string): string | undefined =>
      typeof event[key] === 'string' ? event[key] as string : undefined
    this.recordCodexTranscriptObservation('provider.request', sessionId, {
      phase: codexObservationEnumOrUnknown('provider.request', 'phase', event.phase),
      source: codexObservationEnumOrUnknown('provider.request', 'source', event.source),
      cause: codexObservationEnumOrUnknown('provider.request', 'cause', event.cause),
      ...(typeof event.selected === 'boolean' ? { selected: event.selected } : {}),
      ...(typeof event.subagentHeaderPresent === 'boolean'
        ? { subagentHeaderPresent: event.subagentHeaderPresent }
        : {}),
    }, {
      ...(stringId('requestId') ? { proxyRequestId: stringId('requestId') } : {}),
      ...(stringId('flowId') ? { proxyFlowId: stringId('flowId') } : {}),
      ...(stringId('providerSessionFingerprint')
        ? { providerWindowFingerprint: stringId('providerSessionFingerprint') }
        : {}),
      ...(stringId('providerWindowGenerationId')
        ? { providerWindowGenerationId: stringId('providerWindowGenerationId') }
        : {}),
    }, expectedSessionRunId)
  }

  private observeCodexTranscriptDiagnostic(
    sessionId: string,
    value: unknown,
    expectedSessionRunId: string,
  ): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const diagnostic = value as Record<string, unknown>
    if (diagnostic.type === 'provider-request-observation') {
      this.observeCodexProviderRequest(
        sessionId,
        diagnostic.observation,
        expectedSessionRunId,
      )
      return true
    }
    if (diagnostic.type === 'prompt-input-evidence' && diagnostic.available === false) {
      // WHY consume this in main instead of forwarding it to the renderer:
      // refusal to issue the legacy 0.149.1 prompt-attestation capability is
      // neither transcript failure nor product state. Exact proxy identity can
      // still attach a current Codex rollout. Recording the closed reason here
      // preserves the incident breadcrumb without creating another UI route
      // that could regress into “transcript unavailable”.
      const code = diagnostic.reason === 'unsupported-cli'
        ? 'unsupported-cli'
        : 'unknown'
      this.recordCodexTranscriptObservation('transcript.attachment', sessionId, {
        decision: 'hold',
        reason: 'prompt-evidence-disabled',
        code,
        attached: false,
        tailing: false,
      }, undefined, expectedSessionRunId)
      return true
    }
    if (diagnostic.type !== 'fresh-rollout-ownership-decision') return false
    const evidence = diagnostic.evidence && typeof diagnostic.evidence === 'object'
      ? diagnostic.evidence as Record<string, unknown>
      : {}
    const candidateFingerprint = typeof evidence.leasedCandidateFingerprint === 'string'
      ? evidence.leasedCandidateFingerprint
      : undefined
    const fingerprintArray = (key: string): string[] => Array.isArray(evidence[key])
      ? evidence[key].filter((item): item is string => typeof item === 'string')
      : []
    const matchingFingerprints = new Set(fingerprintArray('matchingCandidateFingerprints'))
    const providerSessionByCandidate = new Map<string, string>()
    if (Array.isArray(evidence.candidateProviderSessionFingerprints)) {
      for (const value of evidence.candidateProviderSessionFingerprints) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue
        const relation = value as Record<string, unknown>
        if (typeof relation.candidateFingerprint !== 'string' ||
          typeof relation.providerSessionMetaFingerprint !== 'string') continue
        const safeIds = pickLifecycleCorrelationIds({
          candidateFingerprint: relation.candidateFingerprint,
          providerSessionMetaFingerprint: relation.providerSessionMetaFingerprint,
        })
        if (safeIds?.candidateFingerprint && safeIds.providerSessionMetaFingerprint) {
          providerSessionByCandidate.set(
            safeIds.candidateFingerprint,
            safeIds.providerSessionMetaFingerprint,
          )
        }
      }
    }
    const observedFingerprints = [...new Set([
      ...matchingFingerprints,
      ...fingerprintArray('candidateFingerprints'),
    ])].filter(fingerprint =>
      pickLifecycleCorrelationIds({ candidateFingerprint: fingerprint }) !== undefined,
    )

    // Record each graph edge transition once per concrete backend run.
    // Ownership recomputes the same decision whenever any sibling changes;
    // journalling all 32 candidates on every recompute multiplied one logical
    // edge into thousands of pending rows with a large same-cwd grid. The
    // matched bit is part of the key because false -> true is new evidence.
    // A per-run ceiling keeps 100 panes below the shared 2k pending budget.
    const prioritizedFingerprints = [
      ...observedFingerprints.filter(value => matchingFingerprints.has(value)),
      ...observedFingerprints.filter(value => !matchingFingerprints.has(value)),
    ]
    const sessionRunId = expectedSessionRunId
    const previousEdges = this.codexCandidateObservationEdges.get(sessionId)
    const edges = sessionRunId && previousEdges?.sessionRunId === sessionRunId
      ? previousEdges
      : sessionRunId
        ? {
            sessionRunId,
            seenKeys: new Set<string>(),
            emittedKeys: new Set<string>(),
            emittedCount: 0,
            trackingCapped: false,
          }
        : null
    if (edges && edges !== previousEdges) {
      this.codexCandidateObservationEdges.set(sessionId, edges)
    }
    let suppressedCandidateCount = 0
    for (const fingerprint of prioritizedFingerprints) {
      if (!edges) continue
      const matched = matchingFingerprints.has(fingerprint)
      const providerSessionMetaFingerprint = providerSessionByCandidate.get(fingerprint)
      const edgeKey = [
        fingerprint,
        matched ? 'matched' : 'unmatched',
        providerSessionMetaFingerprint ?? 'no-session-meta',
      ].join(':')
      if (!edges.seenKeys.has(edgeKey)) {
        // The ledger cap is itself evidence loss. Once crossed, we keep
        // reporting that fact and stop pretending later unknown keys are new.
        // `emittedKeys` remains separately exact because it is bounded by 8.
        if (edges.seenKeys.size < MAX_CODEX_CANDIDATE_EDGE_KEYS_PER_RUN) {
          edges.seenKeys.add(edgeKey)
        } else {
          edges.trackingCapped = true
        }
        if (edges.emittedCount < MAX_CODEX_CANDIDATE_OBSERVATIONS_PER_RUN) {
          edges.emittedCount += 1
          edges.emittedKeys.add(edgeKey)
          this.recordCodexTranscriptObservation('transcript.candidate', sessionId, {
            phase: 'pre-lease',
            matched,
          }, {
            candidateFingerprint: fingerprint,
            ...(providerSessionMetaFingerprint
              ? { providerSessionMetaFingerprint }
              : {}),
          }, expectedSessionRunId)
        }
      }
      // `suppressed` describes the current decision's missing graph edges,
      // not how many callbacks happened to arrive. Recomputing it against the
      // exact bounded emitted set makes byte-identical 300-candidate decisions
      // dedupe even after the larger seen ledger reaches its memory ceiling.
      if (!edges.emittedKeys.has(edgeKey)) suppressedCandidateCount += 1
    }

    const attachmentData = pickCodexTranscriptObservationData('transcript.attachment', {
      decision: typeof diagnostic.decision === 'string' ? diagnostic.decision : 'unknown',
      reason: typeof diagnostic.reason === 'string' ? diagnostic.reason : 'unknown',
      attached: diagnostic.tailStarted === true,
      tailing: diagnostic.tailStarted === true,
      candidateCount: typeof evidence.candidateCount === 'number'
        ? evidence.candidateCount
        : 0,
      matchingCandidateCount: typeof evidence.matchingCandidateCount === 'number'
        ? evidence.matchingCandidateCount
        : 0,
      // Dedupe means the edge is already present in this run's observation
      // stream, not suppressed. Count only previously-unseen current edges the
      // per-run ceiling prevented us from writing on this decision.
      suppressed: suppressedCandidateCount,
      ...(edges?.trackingCapped ? { trackingCapped: true } : {}),
    })
    const attachmentIds = pickCodexTranscriptObservationCorrelationIds(
      'transcript.attachment',
      candidateFingerprint ? {
      candidateFingerprint,
      ...(providerSessionByCandidate.get(candidateFingerprint)
        ? { providerSessionMetaFingerprint: providerSessionByCandidate.get(candidateFingerprint) }
        : {}),
      } : undefined,
      attachmentData,
    )
    const previousAttachmentState = this.codexAttachmentObservationState.get(sessionId)
    const attachmentState = sessionRunId &&
      previousAttachmentState?.sessionRunId === sessionRunId
      ? previousAttachmentState
      : sessionRunId
        ? {
            sessionRunId,
            lastTransitionKey: null,
            emittedTransitions: 0,
            capReported: false,
          }
        : null
    if (attachmentState && attachmentState !== previousAttachmentState) {
      this.codexAttachmentObservationState.set(sessionId, attachmentState)
    }
    if (attachmentState) {
      const transitionKey = JSON.stringify([attachmentData ?? null, attachmentIds ?? null])
      if (attachmentState.lastTransitionKey === transitionKey) return false
      attachmentState.lastTransitionKey = transitionKey
      if (attachmentState.emittedTransitions < MAX_CODEX_ATTACHMENT_TRANSITIONS_PER_RUN) {
        attachmentState.emittedTransitions += 1
        this.recordCodexTranscriptObservation(
          'transcript.attachment',
          sessionId,
          attachmentData,
          attachmentIds,
          expectedSessionRunId,
        )
      } else if (!attachmentState.capReported) {
        // One final tombstone makes suppression explicit. Continuing to write a
        // row for every coordinator recompute would let N fresh panes evict the
        // sparse submit chain from AppRunJournal's bounded pending buffer.
        attachmentState.capReported = true
        this.recordCodexTranscriptObservation('transcript.attachment', sessionId, {
          ...(attachmentData ?? {}),
          trackingCapped: true,
        }, attachmentIds, expectedSessionRunId)
      }
    }
    return false
  }

  // Record that main owned this session id, for input_write_failed disambiguation.
  private rememberSessionId(sessionId: string): void {
    this.everKnownSessionIds.add(sessionId)
    if (this.everKnownSessionIds.size > 8192) {
      // Bound memory: evict the oldest id (Set preserves insertion order). Evicted
      // ids are long-dead sessions; a late write to one is vanishingly unlikely.
      const oldest = this.everKnownSessionIds.values().next().value
      if (oldest !== undefined) {
        this.everKnownSessionIds.delete(oldest)
      }
    }
  }

  private codexSessionRunKey(sessionId: string, sessionRunId: string): string {
    // Both components are UUIDs at the production boundary, but length-prefix
    // the pane id instead of depending on a delimiter invariant. This helper is
    // also exercised by intentionally non-UUID unit session ids and an exact
    // key must remain collision-free there too.
    return `${sessionId.length}:${sessionId}${sessionRunId}`
  }

  private rememberCodexSessionRun(
    sessionId: string,
    sessionRunId: string,
    state: CodexSessionRunState,
  ): void {
    const key = this.codexSessionRunKey(sessionId, sessionRunId)
    // Map.set does not refresh insertion order for an existing key. Delete
    // first so a just-retired run receives a full teardown-race retention
    // window instead of being evicted according to its much older spawn time.
    this.recentCodexSessionRuns.delete(key)
    this.recentCodexSessionRuns.set(key, { sessionId, sessionRunId, state })
    while (this.recentCodexSessionRuns.size > RECENT_CODEX_SESSION_RUN_LIMIT) {
      const oldest = this.recentCodexSessionRuns.keys().next().value
      if (oldest === undefined) break
      this.recentCodexSessionRuns.delete(oldest)
    }
  }

  /**
   * Claude-specific accessor for the paste-submit event-driven path
   * in `src/renderer/.../claudePaste.ts`. Returns the live ClaudeSession
   * cast through `unknown` because AgentSessionLike doesn't (and
   * shouldn't) expose `awaitPastePlaceholder` — that's a Claude-only
   * affordance and adding it to the cross-provider interface would
   * force every other runtime to ship a no-op stub.
   *
   * Returns `null` for missing sessions or non-Claude kinds. Callers
   * MUST treat null as a benign "couldn't reach this session" and
   * fall through to whatever non-event-driven path they were using
   * before; the absence of a Claude session is not an error worth
   * crashing over.
   */
  async awaitClaudePastePlaceholder(
    sessionId: string,
    opts?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<
    | { kind: 'appeared'; waitedMs: number }
    | { kind: 'timeout' }
    | { kind: 'no-headless' }
    | { kind: 'no-session' }
  > {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.kind !== 'claude') return { kind: 'no-session' }
    // The cross-provider AgentSessionLike interface doesn't carry
    // `awaitPastePlaceholder`; ClaudeSession does. We assert via a
    // structural duck-type so misconfigured Claude provider builds
    // (a future ClaudeSession that loses the method) surface as
    // 'no-session' rather than a TypeError.
    // No cast: awaitPastePlaceholder is now a typed optional on
    // AgentSession (see @shared/types/session.ts).
    const session = entry.session
    if (typeof session.awaitPastePlaceholder !== 'function') {
      return { kind: 'no-session' }
    }
    return session.awaitPastePlaceholder(opts)
  }

  async resolveCondition(
    sessionId: string,
    action: ConditionCustomAction,
  ): Promise<ResolveConditionResult> {
    // Provider condition resolvers synthesize PTY keystrokes internally and
    // cannot use writeReserved. Letting one answer a dialog while prompt
    // delivery owns the composer can splice bytes into the paste or consume
    // its Enter. Rejecting is safe: condition state remains visible and the
    // caller can retry after the bounded delivery finishes.
    if (this.promptDeliveriesInFlight.has(sessionId)) {
      return {
        ok: false,
        reason: 'aborted',
        failedAtStep: 'prompt delivery in progress',
      }
    }
    const entry = this.sessions.get(sessionId)
    // ANY agent kind may carry a resolver now (#394 phase 3) — the
    // old `entry.kind !== 'claude'` gate meant a provider that
    // implemented AgentSession.resolveCondition still got a dead-end
    // 'no-session' from the manager (#394 §5). `=== 'terminal'`
    // rather than !isAgentProviderKind because TypeScript only
    // discriminates the RegistryEntry union on literal comparisons.
    // A provider without a resolver (Codex today — its approvals
    // answer via raw keystrokes) hits the capability check below and
    // returns 'no-resolver', which is truthful.
    if (!entry || entry.kind === 'terminal') {
      return { ok: false, reason: 'no-session' }
    }
    if (typeof entry.session.resolveCondition !== 'function') {
      return { ok: false, reason: 'no-resolver' }
    }
    // The AgentSession contract types `reason` as a plain string (a
    // provider defines its own failure vocabulary); the app-side
    // ResolveConditionResult narrows to the known reason set for
    // renderer/IPC consumers. The cast asserts providers keep their
    // reasons within that set — Claude's DriveResult does; a new
    // provider's resolver must too (documented on the contract).
    // Condition resolvers synthesize their own keystrokes inside the provider —
    // free text and Enter, in the AskUserQuestion case — reaching the PTY
    // through the headless write callback rather than either instrumented
    // function here. Review caught that this made the journal's
    // "cannot miss a writer by construction" claim false: an answered dialog
    // could put text in the composer with nothing recorded, which is precisely
    // the blind spot the event exists to close.
    //
    // Recorded at the call boundary rather than inside the provider because
    // this is where every resolver converges, and because the manager is what
    // owns the journal. Byte counts are unknown from here — the provider
    // decides them — so this records the ACT, which is the part that matters
    // for attribution.
    this.recordInputWrite(sessionId, '', 'condition')
    return entry.session.resolveCondition(action) as Promise<ResolveConditionResult>
  }

  /**
   * Deliver a prompt to an agent session using the PROVIDER'S OWN
   * delivery protocol (#394 phase 2c).
   *
   * WHY this lives on the manager instead of MCP calling the registry
   * directly: the provider implementations need the live AgentSession
   * object plus a liveness-aware write, and both are manager-owned
   * state. MCP (and any future caller — composer flows, dispatch)
   * gets one provider-agnostic entry point; the per-provider
   * discipline (Codex readiness-gate + atomic paste+Enter, Claude
   * paste/image absorption → Enter → durable acceptance) lives in
   * providers/<kind>/runtime/promptDelivery.ts.
   *
   * An unknown/non-agent kind is a LOUD failure — the predecessor
   * inline branches let a third provider fall through to a
   * protocol-free paste with no readiness gate and no confirmation
   * (#394 §4.2).
   */
  async deliverPromptToAgent(
    sessionId: string,
    prompt: string,
    imagePaths?: string[],
    record?: (event: string, data?: Record<string, unknown>) => void,
  ): Promise<PromptDeliveryResult> {
    if (this.promptDeliveriesInFlight.has(sessionId)) {
      record?.('duplicate-blocked')
      this.lifecycle.session('delivery.reject', sessionId, {
        code: 'delivery-in-flight',
        stage: 'reservation',
        registryHit: this.sessions.has(sessionId),
      })
      return {
        ok: false, stage: 'reservation', code: 'delivery-in-flight',
        retrySafe: true, disposition: 'retry-same-session',
        promptWritten: false, enterWritten: false,
        message: `A prompt delivery is already in flight for session ${sessionId}`,
      }
    }
    const entry = this.sessions.get(sessionId)
    // `=== 'terminal'` rather than !isAgentProviderKind: TypeScript
    // only discriminates the RegistryEntry union on literal kind
    // comparisons, and we need `entry.session` narrowed to
    // AgentSession for the registry call below.
    if (!entry || entry.kind === 'terminal') {
      // ── THE REPORTED FAILURE ──
      // "Cannot deliver prompt: <id> is not a live agent session", followed by
      // a pane stuck on `Sending · 17s` until the agent is reloaded.
      //
      // This branch is REGISTRY SPLIT-BRAIN: the renderer believes the pane is
      // started, ready and writable, while main holds no entry for it. Why the
      // entry is missing is NOT derivable from source — the candidates (an exit
      // the renderer never processed, a cancelled recovery, a kill, a wedged
      // provider) are indistinguishable at this line.
      //
      // `everKnown` is the discriminator that makes them distinguishable in the
      // corpus, and it is the whole reason this event exists: an id main has
      // NEVER owned means the renderer invented or resurrected it (a
      // persistence/ownership bug), while an id main owned and lost means a
      // lifecycle teardown was not observed by the renderer (an event-delivery
      // bug). Those are different defects in different files, and today they
      // produce byte-identical user-visible symptoms.
      this.lifecycle.session('delivery.reject', sessionId, {
        code: 'not-ready',
        stage: 'before-write',
        registryHit: Boolean(entry),
        reason: entry ? 'terminal-session' : this.everKnownSessionIds.has(sessionId)
          ? 'entry-lost-after-owned'
          : 'never-owned',
      })
      return {
        ok: false, stage: 'before-write', code: 'not-ready', retrySafe: true,
        disposition: 'session-unusable',
        promptWritten: false, enterWritten: false,
        message: `Cannot deliver prompt: ${sessionId} is not a live agent session`,
      }
    }
    this.promptDeliveriesInFlight.add(sessionId)
    record?.('reserved')
    let promptWritten = false
    let enterWritten = false
    try {
      return await getMainProvider(entry.kind).deliverPrompt({
        session: entry.session,
        // WHY identity-check every delayed write: provider protocols await
        // absorption/readiness. A same-ID wake must never receive Enter from a
        // delivery that began against the process which just exited.
        write: data => {
          const wrote = this.writeReserved(sessionId, entry, data, () => {
            if (data === '\r' || data.endsWith('\r')) enterWritten = true
            if (data !== '\r') promptWritten = true
          })
          return wrote
        },
        sessionId,
        prompt,
        imagePaths,
        record,
      })
    } catch (err) {
      record?.('uncertain', { reason: 'provider-threw' })
      return {
        ok: false,
        stage: enterWritten ? 'after-enter' : promptWritten ? 'absorption' : 'before-write',
        code: 'transport-failed',
        message: `Prompt delivery failed unexpectedly: ${
          err instanceof Error ? err.message : String(err)
        }`,
        // The coordinator cannot know how far provider code progressed before
        // throwing. Conservatively forbid automatic retry.
        retrySafe: !promptWritten && !enterWritten,
        disposition: !promptWritten && !enterWritten
          ? 'session-unusable'
          : 'do-not-retry',
        promptWritten,
        enterWritten,
      }
    } finally {
      this.promptDeliveriesInFlight.delete(sessionId)
      record?.('released')
    }
  }

  /** Submit staged composer content only when no finished-prompt transaction
   * owns the session. Remote's legacy `submit` command cannot be allowed to
   * inject Enter during paste absorption. */
  submitStagedPrompt(sessionId: string): boolean {
    if (this.promptDeliveriesInFlight.has(sessionId)) return false
    return this.write(sessionId, '\r')
  }

  /** Resize a session's terminal + PTY. No-op if session doesn't exist. */
  resize(sessionId: string, cols: number, rows: number): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    entry.session.resize(cols, rows)
    this.sessionSizes.set(sessionId, { cols, rows })
  }

  /**
   * Kill a session and remove it from the registry. Returns true if
   * the session existed and was killed.
   */
  async kill(sessionId: string): Promise<boolean> {
    return await this.killInternal(sessionId)
  }

  private async killInternal(
    sessionId: string,
    authorizedReplacement: CodexReplacementReservationRecord | null = null,
    authorizedRedirect: CodexReplacementRedirect | null = null,
  ): Promise<boolean> {
    const replacement = this.findCodexReplacementReservation(sessionId)
    const cancelledReclaims = new Set<CodexReplacementReclaim<RecoveryClaim>>()
    let cancelsRedirect = false
    for (const redirect of this.codexReplacements.redirects()) {
      const targetsRedirect =
        redirect.predecessorSessionId === sessionId ||
        redirect.successorSessionId === sessionId
      const authorized =
        redirect === authorizedRedirect ||
        Boolean(
          authorizedRedirect &&
          authorizedRedirect.successorSessionId === sessionId &&
          redirect.successorSessionId === sessionId,
        ) ||
        Boolean(
          authorizedReplacement &&
          redirect.successorSessionId === sessionId &&
          authorizedReplacement.predecessorSessionId === sessionId,
        )
      if (
        targetsRedirect &&
        !authorized
      ) {
        // A close of either the stale predecessor or current successor is user
        // teardown intent. Publish it before stop awaits so an already-running
        // stale-renderer reclaim cannot resurrect predecessorId afterward.
        redirect.cancelled = true
        const addressedReclaim = this.codexReplacements.getReclaim(
          redirect.predecessorSessionId,
        )
        const physicalReclaim = this.codexReplacements.getReclaimBySuccessor(
          redirect.successorSessionId,
        )
        for (const reclaim of [addressedReclaim, physicalReclaim]) {
          if (!reclaim) continue
          this.markCodexReplacementReclaimCancelled(reclaim)
          cancelledReclaims.add(reclaim)
        }
        cancelsRedirect = true
      }
    }
    const cancelsReplacement = Boolean(
      replacement && replacement !== authorizedReplacement,
    )
    if (cancelsReplacement && replacement) {
      // WHY cancellation is recorded before any stop await: successor failure
      // and compensation run on other promise continuations. If teardown intent
      // were published after stop, the failure continuation could resurrect the
      // predecessor while an explicit close or app shutdown was still waiting.
      // The destructive handoff passes its reservation as authority; it is the
      // one predecessor kill that transfers ownership instead of cancelling it.
      // An older committed redirect reclaim also cancels a newer replacement,
      // but it is moving ownership back to that older durable ID rather than
      // closing the lineage. Treating it as explicit close would tombstone the
      // very predecessor the reclaim is about to restore.
      const cancelledByAncestorReclaim = Boolean(
        authorizedRedirect &&
        authorizedRedirect.successorSessionId === sessionId,
      )
      this.cancelCodexReplacementReservation(
        replacement,
        this.shuttingDown
          ? 'shutdown'
          : cancelledByAncestorReclaim
            ? null
            : 'explicit-close',
      )
      const reclaim = this.codexReplacements.getReclaim(
        replacement.predecessorSessionId,
      )
      if (reclaim) cancelledReclaims.add(reclaim)
    }
    // Start teardown of a predecessor-keyed restoration before awaiting any
    // entry stop addressed by the renderer's stale/successor ID. Provider start
    // may be the operation holding the reclaim promise open, and stop() is the
    // only real mechanism that can release it. Merely setting both cancellation
    // booleans can therefore deadlock close behind an unreachable backend.
    const restorationClaims = new Map<RecoveryClaim, string>()
    for (const reclaim of cancelledReclaims) {
      if (reclaim.restorationClaim) {
        restorationClaims.set(
          reclaim.restorationClaim,
          reclaim.predecessorSessionId,
        )
      }
    }
    if (cancelsReplacement && replacement?.restorationClaim) {
      restorationClaims.set(
        replacement.restorationClaim,
        replacement.predecessorSessionId,
      )
    }
    const reclaimTeardown = [...restorationClaims].map(([claim, ownerId]) =>
      this.cancelRecoveryClaim(ownerId, claim),
    )
    const recovery = this.recoveriesInFlight.get(sessionId)
    if (recovery) recovery.cancelled = true
    const entry = this.sessions.get(sessionId)
    const generation = entry?.lifecycle.generation ?? recovery?.spawnGeneration ?? null
    // Every backend death passes through here, so this is the one place that
    // can answer "did something kill my agent, or did it never start?" — a
    // question #596 took a bug report and a full source trace to answer once.
    // `cause` separates the three shapes: killing a live entry, cancelling an
    // in-flight recovery, and a no-op kill against an id main does not hold
    // (which usually means the caller is operating on a stale id).
    this.lifecycle.session('kill.request', sessionId, {
      cause: entry ? 'live-entry' : recovery ? 'recovery-claim' : 'no-owner',
      kind: entry?.kind ?? recovery?.kind ?? null,
    })

    // WHY registry visibility is severed now but the spawn-generation fence is
    // not: callers must stop routing input immediately, yet a replacement may
    // not start while the abandoned provider can still perform tools or other
    // external mutations. spawnWithId releases the fence only after startup
    // settles and its generation-owned rollback has attempted both pre- and
    // post-start stops. Renderer bootstrap has its own bounded deadline, so a
    // pathological provider cannot hide the workspace while this safety fence
    // remains honest in main.
    if (entry && this.sessions.get(sessionId) === entry) {
      this.removeEntryListeners(entry)
      this.emit('removed', { sessionId })
      this.cleanupSessionState(sessionId, entry.kind, entry)
    } else if (recovery && generation) {
      this.cleanupSessionState(
        sessionId,
        recovery.kind,
        undefined,
        recovery.kind !== 'terminal',
        generation,
      )
    }

    if (entry) {
      // For tmux-backed terminals, stop() detaches the client but intentionally
      // leaves the tmux session alive for undo-close. Failed spawn rollback is
      // different and destroys only the tmux server created by that transaction.
      await this.requestEntryStop(sessionId, entry)
    }
    await Promise.all(reclaimTeardown)

    if (
      cancelsReplacement &&
      replacement &&
      sessionId === replacement.predecessorSessionId
    ) {
      // The renderer only knows the old local ID until replacement spawn
      // returns. Closing that pane must also stop the hidden successor already
      // registered under its new random ID; otherwise a cancelled replacement
      // can keep a provider alive with no renderer owner. Passing the reservation
      // prevents this internal cascade from being mistaken for a second cause.
      await this.killInternal(replacement.successorSessionId, replacement)
    }
    if (
      cancelsReplacement &&
      replacement?.spawnOutcome === 'successor-live' &&
      this.codexReplacements.getReservationByPredecessor(
        replacement.predecessorSessionId,
      ) === replacement
    ) {
      // Once spawn IPC has returned there is no outer finally left to retire a
      // later close. The explicit teardown already stopped whichever side was
      // still live, so retaining the transaction would only reserve a dead ID
      // forever and make shutdown/recovery report a replacement that no longer
      // exists.
      this.retireCodexReplacementReservation(replacement)
    }
    // Redirect retirement is deliberately not coupled to physical process
    // teardown. Successful stale recovery removes it immediately before
    // restoring predecessorId; explicit close leaves a cancelled tombstone so
    // another already-loaded renderer cannot fall through to ordinary recovery
    // and resurrect the closed lineage.
    return Boolean(entry || recovery || cancelsReplacement || cancelsRedirect)
  }

  /** Kill only when the caller's durable workspace ownership still matches. */
  async killOwned(options: SessionOwnershipOptions): Promise<boolean> {
    return await this.killOwnedInternal(options)
  }

  private async killOwnedInternal(
    options: SessionOwnershipOptions,
    authorizedReplacement: CodexReplacementReservationRecord | null = null,
  ): Promise<boolean> {
    const requestedKind: unknown = options.kind
    if (requestedKind !== undefined && !isSessionKind(requestedKind)) return false
    const kind = options.kind ?? DEFAULT_PROVIDER
    const cwd = path.resolve(options.cwd)
    const entry = this.sessions.get(options.sessionId)
    const claim = this.recoveriesInFlight.get(options.sessionId)
    const replacement = this.findCodexReplacementReservation(options.sessionId)
    const redirects = this.codexReplacements.findRedirects(options.sessionId)

    // WHY check and kill occur without an await between them: this is the
    // atomic ownership proof missing from renderer-only guards. A stale pane
    // may share a local id with another project, but it cannot terminate that
    // backend unless both provider kind and lexical cwd still match in main.
    if (entry) {
      const snapshot = this.getBackendSnapshot(options.sessionId)
      if (!snapshot || snapshot.kind !== kind || path.resolve(snapshot.cwd) !== cwd) {
        return false
      }
    } else if (claim) {
      if (claim.kind !== kind || claim.cwd !== cwd) return false
    } else if (redirects.length > 0) {
      if (redirects.some(redirect => {
        // A redirect carries two independently valid routing identities. A
        // same-resume replacement may intentionally change cwd, so validating
        // reverse close of S with P's captured cwd turns a real user close into
        // a stale miss after S has naturally exited.
        const ownership = redirect.predecessorSessionId === options.sessionId
          ? redirect.predecessorOwnership
          : redirect.successorOwnership
        return (
          (ownership.kind ?? DEFAULT_PROVIDER) !== kind ||
          path.resolve(ownership.cwd) !== cwd
        )
      })) {
        return false
      }
      const teardownIds = new Set<string>([options.sessionId])
      for (const redirect of redirects) {
        redirect.cancelled = true
        const reclaims = new Set([
          this.codexReplacements.getReclaim(redirect.predecessorSessionId),
          this.codexReplacements.getReclaimBySuccessor(
            redirect.successorSessionId,
          ),
        ])
        for (const reclaim of reclaims) {
          if (!reclaim) continue
          this.markCodexReplacementReclaimCancelled(reclaim)
          // The active backend may already have moved from redirect.successorId
          // to reclaim.predecessorId. Following that explicit owner makes close
          // wait for real provider teardown rather than return after a no-op kill
          // against the now-empty routing ID.
          teardownIds.add(reclaim.predecessorSessionId)
        }
        if (redirect.predecessorSessionId === options.sessionId) {
          teardownIds.add(redirect.successorSessionId)
        }
      }
      await Promise.all([...teardownIds].map(id => this.killInternal(id)))
      // The redirect itself is main-owned teardown work even when the first
      // reclaim continuation already removed the target registry row before
      // this close reached it. Report the cancellation as handled so renderer
      // close does not mistake an idempotent joined stop for a stale miss.
      return true
    } else {
      // During destructive handoff the predecessor row is intentionally gone,
      // and during compensation preflight the recovery claim is the owner. The
      // reservation preserves the original main-verified kind/cwd so a close
      // against that still-visible pane can cancel the hidden successor without
      // turning an arbitrary stale ID into teardown authority.
      const reservedOwnership = replacement
        ? replacement.predecessorSessionId === options.sessionId
          ? replacement.predecessorOwnership
          : replacement.successorOwnership
        : null
      if (
        !reservedOwnership ||
        (reservedOwnership.kind ?? DEFAULT_PROVIDER) !== kind ||
        path.resolve(reservedOwnership.cwd) !== cwd
      ) {
        return false
      }
    }
    return await this.killInternal(options.sessionId, authorizedReplacement)
  }

  private async cancelRecoveryClaim(
    sessionId: string,
    claim: RecoveryClaim,
  ): Promise<void> {
    claim.cancelled = true
    const entry = this.sessions.get(sessionId)
    const ownsEntry = Boolean(
      entry &&
      claim.spawnGeneration &&
      entry.lifecycle.generation === claim.spawnGeneration,
    )
    if (entry && ownsEntry) {
      this.removeEntryListeners(entry)
      this.emit('removed', { sessionId })
      this.cleanupSessionState(sessionId, entry.kind, entry)
      await this.requestEntryStop(sessionId, entry)
    } else if (claim.spawnGeneration) {
      this.cleanupSessionState(
        sessionId,
        claim.kind,
        undefined,
        claim.kind !== 'terminal',
        claim.spawnGeneration,
      )
    }
  }

  /** Cancel only a matching recovery/reclaim generation, never an adopted entry. */
  async cancelRecovery(options: SessionRecoveryCancellationOptions): Promise<boolean> {
    const requestedKind: unknown = options.kind
    if (requestedKind !== undefined && !isSessionKind(requestedKind)) return false
    const kind = options.kind ?? DEFAULT_PROVIDER
    const cwd = path.resolve(options.cwd)
    const claim = this.recoveriesInFlight.get(options.sessionId)
    const reclaim = this.codexReplacements.getReclaim(options.sessionId)
    const reclaimMatches = Boolean(
      reclaim &&
      reclaim.kind === kind &&
      reclaim.cwd === cwd &&
      reclaim.recoveryTokens.has(options.recoveryToken)
    )
    const ownsClaim = Boolean(
      claim &&
      claim.kind === kind &&
      claim.cwd === cwd &&
      claim.recoveryTokens.has(options.recoveryToken)
    )
    if (!ownsClaim && !reclaimMatches) return false

    // A reclaim record exists before its final ordinary RecoveryClaim. Mark it
    // even when the ordinary claim is also present: cancellation can arrive in
    // the narrow interval after reclaim called recover() but before that nested
    // recovery settles, and both layers must observe the same deadline.
    const claimsToCancel = new Set<RecoveryClaim>()
    const teardown: Array<Promise<unknown>> = []
    if (reclaimMatches && reclaim) {
      reclaim.cancelled = true
      if (reclaim.restorationClaim) {
        // A restored predecessor intentionally has its own opaque token so an
        // unrelated stale recovery cannot cancel it. This reclaim is different:
        // it caused that exact claim and carries an explicit pointer to it, so
        // any renderer token admitted to the reclaim may cancel the associated
        // restoration without widening matching to another generation.
        claimsToCancel.add(reclaim.restorationClaim)
      }
      const reservation = this.codexReplacements.getReservationByPredecessor(
        reclaim.predecessorSessionId,
      )
      if (reservation) {
        this.cancelCodexReplacementReservation(reservation, null)
        // Do not wait for successor start to settle before initiating stop: the
        // entire bug is that start may be the hung operation. Authorization
        // prevents this internal timeout teardown from becoming close intent.
        teardown.push(
          this.killInternal(reservation.successorSessionId, reservation),
        )
      }
    }
    if (ownsClaim && claim) claimsToCancel.add(claim)

    // WHY this is distinct from killOwned: a renderer deadline can fire while
    // an earlier recover IPC is merely queued behind a blocked main event loop.
    // By the time cancellation is processed, recover may already have returned
    // an ownership conflict, adopted a healthy backend, or replacement may have
    // published compensation generation C under the same stable tuple. The
    // opaque token makes every delayed message a no-op unless it still names
    // the exact claim generation R whose renderer deadline fired.
    for (const ownedClaim of claimsToCancel) {
      teardown.push(this.cancelRecoveryClaim(options.sessionId, ownedClaim))
    }
    await Promise.all(teardown)
    return true
  }

  getProcessTelemetryTargets(sessionIds?: string[]): Array<{
    sessionId: string
    kind: SessionKind
    pid: number | null
    exited: boolean
    lastActivityAt: number | null
  }> {
    const ids = sessionIds ?? Array.from(this.sessions.keys())
    return ids.map(sessionId => {
      const entry = this.sessions.get(sessionId)
      if (!entry) {
        return {
          sessionId,
          kind: 'terminal' as SessionKind,
          pid: null,
          exited: true,
          lastActivityAt: this.lastActivityAt.get(sessionId) ?? null,
        }
      }
      // getProcessPid / isExited are typed optionals on AgentSession
      // (and on TerminalSession's structural surface); no cast needed.
      const s = entry.session
      return {
        sessionId,
        kind: entry.kind,
        pid: s.getProcessPid?.() ?? null,
        exited: s.isExited?.() === true,
        lastActivityAt: this.lastActivityAt.get(sessionId) ?? null,
      }
    })
  }

  /** List all live session ids. Used for state save / debug. */
  list(): string[] {
    return Array.from(this.sessions.keys())
  }

  /** Latest screen snapshot observed for a live session, or null before the
   *  first frame. See the cache fields' WHY comment — this exists for
   *  late-attaching consumers (remote companion) to seed their state. */
  getScreenSnapshot(sessionId: string): AgentScreenSnapshot | null {
    return this.lastScreenSnapshot.get(sessionId) ?? null
  }

  /** Latest provider-conditions snapshot for a live session, or null if no
   *  condition has ever been live. Same late-attach rationale as
   *  getScreenSnapshot. */
  getConditionsSnapshot(sessionId: string): ProviderConditionSnapshot | null {
    return this.lastConditionsSnapshot.get(sessionId) ?? null
  }

  /** Current level-triggered backend fact used to seed a late renderer. */
  getBackendSnapshot(sessionId: string): SessionBackendSnapshot | null {
    const claim = this.recoveriesInFlight.get(sessionId)
    const entry = this.sessions.get(sessionId)
    const info = this.spawnInfo.get(sessionId)
    if (!entry && !claim && !info) return null
    const kind = entry?.kind ?? info?.kind ?? claim?.kind
    const cwd = info?.cwd ?? claim?.cwd
    if (!kind || !cwd) return null
    return {
      sessionId,
      // WHY recovery must expose the registry generation instead of asking a
      // late renderer to infer it: adoption intentionally emits no duplicate
      // `started` edge, and sessionId survives process replacement. The run id
      // therefore belongs on this level-triggered backend fact. A spawning
      // claim has no registered process yet, so absence remains honest there.
      ...(entry ? { sessionRunId: entry.lifecycle.runId } : {}),
      kind,
      cwd,
      lifecycle: entry ? 'live' : 'spawning',
      input: this.lastInputReadiness.get(sessionId) ?? {
        ready: false,
        revision: this.inputReadinessRevision,
        reason: 'starting',
      },
      // WHY the snapshot carries EFFECTIVE domains instead of spawn options:
      // BuiltInMcpHttpHost applies the final provider and environment policy
      // before minting a token. When recovery adopts a still-live backend, the
      // renderer's requested domains cannot change that already-launched
      // process; reporting its token scope is the only way to avoid persisting
      // a UI policy that disagrees with the tools the model actually has.
      ...(isAgentProviderKind(kind)
        ? {
            builtInMcpDomains:
              this.builtInMcpHost?.sessionDomains?.(sessionId) ?? [],
          }
        : {}),
    }
  }

  /** Durable transcript file for a live session, or null before the first
   *  jsonl entry has been observed. See the cache field's WHY. */
  getTranscriptFile(sessionId: string): string | null {
    return this.lastTranscriptFile.get(sessionId) ?? null
  }

  /**
   * Transcript file with a resume-aware fallback: when no jsonl entry has
   * been observed THIS app run (the common state for every restored session
   * right after a restart), a resumed session's transcript is re-derived
   * from its spawn-time {cwd, resumeSessionId} through the same provider
   * resolver history loading uses. Fresh sessions genuinely have no
   * transcript until their first entry — null is correct for them.
   */
  async resolveTranscriptFile(sessionId: string): Promise<string | null> {
    const observed = this.lastTranscriptFile.get(sessionId)
    if (observed) return observed
    const info = this.spawnInfo.get(sessionId)
    const kind = this.getSessionKind(sessionId)
    if (!info?.resumeSessionId || !kind || kind === 'terminal') return null
    try {
      return await resolveProviderTranscriptPath({
        kind,
        cwd: info.cwd,
        providerSessionId: info.resumeSessionId,
      })
    } catch {
      // Resolution is best-effort: a missing project dir or unreadable
      // sessions root should degrade to "no history yet", not break the
      // caller's reply path.
      return null
    }
  }

  /** Workspace cwd captured at spawn — the label a session list should
   *  show (the 'started' event's projectDir is provider-internal). */
  getSpawnCwd(sessionId: string): string | null {
    return this.spawnInfo.get(sessionId)?.cwd ?? null
  }

  /** Epoch ms of the last observed activity (any relayed session event). */
  getLastActivityAt(sessionId: string): number | null {
    return this.lastActivityAt.get(sessionId) ?? null
  }

  /** Kill every live session. Called on app quit. */
  async killAll(): Promise<void> {
    this.shuttingDown = true
    // Recoveries can still be in the pre-entry tool/tmux/MCP phase and are not
    // visible in list(). Shutdown must mark those claims cancelled too so they
    // cannot publish a provider after the app has begun quitting.
    // Replacement successors have the same invisible pre-entry window. Mark
    // every reservation first, before awaiting any individual stop, so a
    // concurrently failing successor cannot start compensation after the
    // shutdown snapshot. Include both IDs because either side may currently be
    // absent from the registry while still owning transaction work.
    const replacements = [...this.codexReplacements.reservations()]
    for (const replacement of replacements) {
      this.cancelCodexReplacementReservation(replacement, 'shutdown')
    }
    const redirects = [...this.codexReplacements.redirects()]
    for (const redirect of redirects) redirect.cancelled = true
    const reclaims = [...this.codexReplacements.reclaims()]
    for (const reclaim of reclaims) reclaim.cancelled = true
    const replacementIds = replacements.flatMap(replacement => [
      replacement.predecessorSessionId,
      replacement.successorSessionId,
    ])
    const redirectIds = redirects.flatMap(redirect => [
      redirect.predecessorSessionId,
      redirect.successorSessionId,
    ])
    const reclaimIds = reclaims.flatMap(reclaim => [
      reclaim.predecessorSessionId,
      reclaim.successorSessionId,
    ])
    const ids = [
      ...new Set([
        ...this.list(),
        ...this.recoveriesInFlight.keys(),
        ...replacementIds,
        ...redirectIds,
        ...reclaimIds,
      ]),
    ]
    await Promise.all(ids.map(id => this.kill(id)))
    // Registry removal precedes provider stop, so the id snapshot above cannot
    // prove teardown is finished. Join the exact reclaim generations captured
    // before the first await; each rechecks cancellation after its current
    // provider boundary and is forbidden from publishing restoration.
    await Promise.allSettled(reclaims.map(reclaim => reclaim.promise))
  }
}
