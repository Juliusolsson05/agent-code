import type {
  BuiltInMcpDomain,
  BuiltInMcpServerConfig,
} from '@mcp/shared/types.js'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions.js'
import type { SessionKind } from '@shared/types/providerKind.js'

// Re-export the provider/session kind source of truth so callers that
// already import session types from here keep one import. The canonical
// definition (and the rationale for the AgentProviderKind vs SessionKind
// split) lives in providerKind.ts — see that file before adding a kind.
export type { AgentProviderKind, SessionKind } from '@shared/types/providerKind.js'

// WHY recovery types live at the neutral shared boundary: main owns the
// operation, preload transports it, and the renderer consumes it. Defining a
// look-alike at each layer would make the most important fields in the restart
// protocol (the stable local id and readiness revision) vulnerable to silent
// drift. Provider history ids remain launch hints; they are intentionally not
// part of the ownership comparison represented by SessionBackendSnapshot.
export type SessionInputReadiness = {
  ready: boolean
  revision: number
  reason?: 'starting' | 'replaying-history' | 'provider-not-ready' | 'ready'
}

// Provider runtimes know *when* their composer is safe, but they do not own
// the cross-process ordering counter. SessionManager adds `revision` when it
// folds this provider fact into the level-triggered backend snapshot.
export type AgentInputReadiness = Omit<SessionInputReadiness, 'revision'>

export type SessionBackendSnapshot = {
  sessionId: string
  kind: SessionKind
  cwd: string
  lifecycle: 'spawning' | 'live'
  input: SessionInputReadiness
}

export type SessionRecoverOptions = {
  sessionId: string
  kind?: SessionKind
  cwd: string
  cols?: number
  rows?: number
  resumeSessionId?: string
  dangerousMode?: boolean
  useProxy?: boolean
  recoverTmuxName?: string
  builtInMcpDomains?: BuiltInMcpDomain[]
}

export type SessionOwnershipOptions = Pick<
  SessionRecoverOptions,
  'sessionId' | 'kind' | 'cwd'
>

export type SessionRecoverFailureCode =
  | 'ownership-conflict'
  | 'cancelled'
  | 'start-failed'

export type SessionRecoverResult =
  | {
      ok: true
      disposition: 'adopted' | 'spawned'
      snapshot: SessionBackendSnapshot
      tmuxName?: string
    }
  | {
      ok: false
      code: SessionRecoverFailureCode
      retryable: boolean
      message: string
      actual?: Pick<SessionBackendSnapshot, 'kind' | 'cwd' | 'lifecycle'>
    }

// ---------------------------------------------------------------------------
// AgentSession contract (#394 phase 2a)
//
// This is the typed replacement for sessionManager's structural
// AgentSessionLike + `createSession: unknown` + cast. Provider runtimes
// (ClaudeSession, CodexSession, and any future ones registered through
// registry.main.ts) DECLARE they implement AgentSession so mismatches
// fail at compile time inside the provider, not silently at runtime in
// the manager after an event never fires.
//
// WHY a typed event map (AgentSessionEvents) with a strictly-typed
// on/off/emit interface merge (via the AgentSessionEmitter interface
// below), not a bag of `on(event: string, listener: never[])`:
//   1. The previous shape (`on(event, (...args: never[]) => void)`)
//      documented conformance in prose but enforced NOTHING — a
//      provider could drop `screen`, emit a different payload shape
//      for `jsonl-entry`, or misspell `semantic-event`, and it only
//      showed up as "the feature is silently missing". Every event
//      names, payload types, and cadence is now proven by the type.
//   2. This is the seam a third-provider PR touches — being able to
//      say "the compile error tells you what to emit" is the whole
//      point of #394's phase-1 union-derivation work.
//
// WHY the payload types live HERE (in @shared/types) and not in the
// Claude provider or the headless package:
//   sessionManager historically imported ScreenSnapshot from
//   @providers/claude/runtime/claudeSession and JsonlEntry from the
//   claude-code-headless package, which inverted the dependency arrow:
//   the manager (which is supposed to be provider-neutral) knew Claude's
//   types by name. AgentScreenSnapshot / AgentJsonlEntry below are
//   the neutral homes. They start as structural copies of the Claude
//   shapes (that's the wire contract Codex already speaks too — see
//   CodexSession's `screen` event and JSONL-entry forwarding) so this
//   PR is a *rename with dependency-arrow reversal*, not a semantic
//   change. Widening to accommodate an API-only provider (opencode)
//   is phase-7 work.
//
// WHY this file (not sessionManager.ts):
//   sessionManager.ts is main-process code. providers/*/runtime/*
//   files import from shared to declare they implement the contract.
//   Putting AgentSession in sessionManager would force providers to
//   import main from packages/, creating an import cycle and blocking
//   the dispatch-mode "session runtime runs outside the Electron
//   window" escape hatch (see [[dispatch_mode_planned]]).
// ---------------------------------------------------------------------------

/**
 * Structural TUI-screen snapshot. Historically ScreenSnapshot from the
 * Claude headless package; now the provider-neutral name at the shared
 * boundary. The shape is unchanged because Codex already emits
 * identical events through the same channel — this is a home change,
 * not a semantic change.
 *
 * A future API-only provider (opencode) has no terminal to snapshot;
 * that will be modeled by making the `screen` event optional on the
 * capability side of the contract, not by widening this shape.
 */
export type AgentScreenSnapshot = {
  plain: string
  markdown: string
  recent: string
  recentMarkdown: string
}

/**
 * Provider transcript-entry payload. Kept as `Record<string, unknown>`
 * at this seam because Claude and Codex ship entries with fundamentally
 * different shapes on the same event (`type:'user'|'assistant'|...` vs
 * `payload:{...}, type:'response_item'|'event_msg'|...`) and the
 * downstream renderer already narrows by shape — see the four
 * duplicated `isCodexRolloutEntry` sniff sites that phase 2b will
 * kill by promoting a transcript-entry codec onto the registry.
 *
 * Deliberately looser than the headless packages' concrete
 * ClaudeJsonlEntry / CodexRolloutLine so a third provider isn't
 * forced to satisfy Claude's discriminated union at this boundary.
 */
export type AgentTranscriptEntry = Record<string, unknown>

/** Payload for the process-state event: whether the provider is
 *  actively working, plus an optional human-readable status verb. */
export type AgentProcessState = {
  active: boolean
  status?: string
}

/** Legacy per-condition event payloads. These are still emitted by
 *  ClaudeSession alongside the unified `conditions` snapshot; kept
 *  optional on the contract so a provider that only emits `conditions`
 *  isn't forced to fabricate them (see the deprecation note next to
 *  each in claudeSession.ts). Codex already skips them today. */
export type AgentTrustDialogState = {
  visible: boolean
  workspace?: string
}
export type AgentResumePromptState = {
  visible: boolean
  sessionAgeText?: string
  tokenCountText?: string
  options?: string[]
  selectedIndex?: number
}
export type AgentPermissionPromptState = {
  visible: boolean
  title?: string
  toolName?: string
  command?: string
  options?: Array<{ key: string; label: string }>
  selectedIndex?: number
}
/**
 * The event map every AgentSession implementation must satisfy. Keys
 * are event names as emitted; array values are the argument tuple the
 * listener receives.
 *
 * WHY `semantic-event` carries `unknown` (and NOT a union like
 * ClaudeSemanticEvent | CodexSemanticEvent):
 *   The manager is deliberately provider-agnostic and forwards this
 *   payload verbatim to the renderer, which narrows by `ev.type`.
 *   Encoding the union here would re-couple the manager to every
 *   provider's semantic vocabulary; the whole point of the semantic
 *   channel is that new providers can widen the union without
 *   touching main. See EVENT_SPEC.md in the headless packages.
 *
 * `started.projectDir` is optional because it has provider-defined
 * semantics: Claude's is the per-cwd transcript dir; Codex's is the
 * global sessions root; an API provider may not have a directory
 * concept at all. See #394 §2 on the ambiguity.
 */
/**
 * The event map every AgentSession implementation must satisfy.
 *
 * Keys are event names as emitted; array values are the argument tuple
 * the listener receives.
 *
 * Every provider MUST emit `started`, `exit`, `conditions`,
 * `semantic-event`, and typically `pty-data`/`screen`/`jsonl-entry`/
 * `jsonl-error`/`process-state`/`trust-dialog` (all present on both
 * Claude and Codex today; an API-only provider will have optional
 * variants in phase 7).
 *
 * `resume-prompt` and `permission-prompt` are
 * **legacy per-condition events emitted only by Claude** and slated
 * for removal (see ClaudeSession.ts's own deprecation comment). They
 * are NOT part of the required contract — they live on
 * `AgentLegacyClaudeConditionEvents` below, which providers can
 * declare via TypeScript interface-merging when they still want to
 * emit them (Claude does). Sessionmanager subscribes to them
 * unconditionally through the strictly-typed `on()` signature, so a
 * provider that doesn't emit them simply never fires the callback —
 * no runtime cost, and forces provider authors to make an explicit
 * choice.
 */
export type AgentSessionEvents = {
  started: [{ projectDir?: string; proxyUrl?: string }]
  'input-readiness': [AgentInputReadiness]
  'pty-data': [string]
  screen: [AgentScreenSnapshot]
  'jsonl-entry': [AgentTranscriptEntry, string]
  'jsonl-error': [Error]
  'process-state': [AgentProcessState]
  'trust-dialog': [AgentTrustDialogState]
  conditions: [ProviderConditionSnapshot]
  'semantic-event': [unknown]
  exit: [{ exitCode: number; signal?: number }]
} & AgentLegacyClaudeConditionEvents

/**
 * Legacy per-condition events. Historically Claude fired individual
 * `resume-prompt` / `permission-prompt` events
 * alongside the unified `conditions` snapshot; Codex never emitted
 * them. Keeping them here (rather than dropping them outright) lets
 * sessionManager keep its current forwarding without touching the
 * `session:*-prompt` IPC channels the renderer still listens to. A
 * follow-up (part of the conditions-v2 phase, #394 phase 3) removes
 * these when the renderer stops needing them.
 *
 * Providers that don't emit them define the listener signatures
 * anyway (via this shape) — the runtime cost is zero (no emit → no
 * callback), and the shared shape lets sessionManager subscribe
 * without a cast.
 */
export type AgentLegacyClaudeConditionEvents = {
  'resume-prompt': [AgentResumePromptState]
  'permission-prompt': [AgentPermissionPromptState]
}

/**
 * Strictly-typed on/off/emit interface merge — the same pattern the
 * headless packages already use for their own class events. Providers
 * that extend `EventEmitter` can declare this via TypeScript's
 * interface-merging (see ClaudeSession/CodexSession for the pattern)
 * without changing runtime behavior.
 */
export interface AgentSessionEmitter {
  on<K extends keyof AgentSessionEvents>(
    event: K,
    listener: (...args: AgentSessionEvents[K]) => void,
  ): this
  off<K extends keyof AgentSessionEvents>(
    event: K,
    listener: (...args: AgentSessionEvents[K]) => void,
  ): this
  once<K extends keyof AgentSessionEvents>(
    event: K,
    listener: (...args: AgentSessionEvents[K]) => void,
  ): this
  removeAllListeners(event?: keyof AgentSessionEvents): this
  emit<K extends keyof AgentSessionEvents>(
    event: K,
    ...args: AgentSessionEvents[K]
  ): boolean
}

/**
 * The behavioral contract every registered agent provider must satisfy.
 *
 * Optional methods encode capabilities that are legitimately
 * provider-specific today. The manager already duck-types them
 * (sessionManager awaitClaudePastePlaceholder / resolveCondition /
 * awaitCodexReadyForPrompt) — declaring them optional here just makes
 * that duck-typing type-checked. Phase 2c generalizes these into a
 * `promptDelivery` capability shape; the individual optional methods
 * survive until then so the phase-2a diff stays a mechanical
 * refactor.
 */
export interface AgentSession extends AgentSessionEmitter {
  start(): Promise<{ projectDir?: string } | void>
  stop(): Promise<void>
  write(data: string): void
  resize(cols: number, rows: number): void

  /** Optional: does the underlying process have a pid we can display /
   *  attribute performance to? Terminal panes obviously do; API-only
   *  providers may not. */
  getProcessPid?(): number | null
  /** Optional: has the underlying process exited? Same rationale. */
  isExited?(): boolean

  /** Optional (Claude today): drive a screen-derived condition action
   *  through the provider's own driver. Codex has no equivalent and
   *  routes actions through raw `write` today; opencode uses HTTP
   *  permission replies. Phase 3 (conditions v2) generalizes this.
   *
   *  The result type is loose (`{ ok: true; state?: unknown } |
   *  { ok: false; reason: string; ... }`) at this seam so this
   *  contract doesn't depend on sessionManager (that would create an
   *  import cycle). The concrete shape lives with the resolver call
   *  site in sessionManager.ts's exported ResolveConditionResult. */
  resolveCondition?(
    action: import('@shared/types/providerConditions.js').ConditionCustomAction,
  ): Promise<
    | { ok: true; state?: unknown }
    | { ok: false; reason: string; lastState?: unknown; failedAtStep?: string }
  >

  /** Optional (Claude today): wait for the bracketed-paste placeholder
   *  to appear before firing Enter. See sessionManager.ts:952. */
  awaitPastePlaceholder?(
    opts?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<
    | { kind: 'appeared'; waitedMs: number }
    | { kind: 'timeout' }
    | { kind: 'no-headless' }
  >

  /** Optional (Claude today): a synchronous read of the live plain-text TUI
   *  screen (headless snapshotPlain). The prompt-delivery path polls this to
   *  detect the paste-commit *transition* — a NEW `[Pasted text #N]`
   *  placeholder OR the paste's tail newly inlined — before firing Enter, the
   *  same content-match signal the desktop composer uses. Returns '' when the
   *  headless instance isn't up yet. */
  snapshotScreen?(): string

  /**
   * Optional (Claude today): arm an authoritative prompt-acceptance waiter
   * BEFORE Enter is written. Claude acknowledges a finished prompt through
   * either a `type: "user"` JSONL entry (new turn) or a
   * `queue-operation/enqueue` entry (Claude was already working). Keeping the
   * arm synchronous closes the fastest possible race: a local JSONL append can
   * arrive immediately after the PTY consumes Enter, before an `await` resumes.
   *
   * The returned cancel function is load-bearing on absorption failure. A
   * paste that never reaches the Enter phase must not leave a content-bearing
   * waiter alive to accidentally match a later manual submission.
   */
  armPromptAcceptance?(
    prompt: string,
    opts?: {
      timeoutMs?: number
      aliases?: string[]
      requiresImage?: boolean
      expectedImageCount?: number
    },
  ): PromptAcceptanceWaiter

  /** Claude's bootstrap JSONL replay must quiesce before a new waiter can be
   * armed, otherwise a historical identical entry can acknowledge new bytes. */
  isPromptAcceptanceReady?(): boolean

  /** Optional provider-owned readiness boundary before prompt bytes may be
   *  written. `deadlineAt` is absolute so readiness cannot quietly consume a
   *  fresh timeout budget that later delivery phases also assume they own. */
  awaitReadyForPrompt?(
    opts?: { deadlineAt?: number; timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<PromptReadinessOutcome>

  /** Optional (opencode today): deliver a user prompt over the
   *  provider's own transport rather than as PTY keystrokes. Providers
   *  with no terminal (opencode's HTTP server) implement this; the
   *  provider's deliverPrompt protocol calls it instead of io.write.
   *  Claude/Codex leave it undefined and receive prompts as bracketed-
   *  paste PTY writes. Throws on transport failure so the delivery
   *  protocol can report ok:false and the composer keeps the draft. */
  deliverPromptText?(text: string): Promise<void>
}

export type PromptAcceptanceOutcome =
  | { kind: 'user'; acceptedAt: number; entryId?: string }
  | { kind: 'queue'; acceptedAt: number }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'session-exited' }

export type PromptAcceptanceWaiter = {
  promise: Promise<PromptAcceptanceOutcome>
  cancel: () => void
}

/**
 * Provider-owned prompt gate. Warming states are expected to resolve without
 * user action; every other non-ready state is returned immediately so callers
 * can report the real obstruction instead of spending an arbitrary timeout.
 */
export type PromptGateState =
  | { kind: 'ready' }
  | { kind: 'warming'; reason: 'replay-pending' | 'composer-unpainted' }
  | { kind: 'blocked'; condition: string; resolvable: boolean }
  | { kind: 'occupied'; reason: 'human-draft' }
  | { kind: 'terminal'; reason: 'exited' | 'no-headless' }

export type PromptReadinessOutcome =
  | { kind: 'ready'; waitedMs: number }
  | { kind: 'timeout'; waitedMs: number; lastState: Extract<PromptGateState, { kind: 'warming' }> }
  | Exclude<PromptGateState, { kind: 'ready' } | { kind: 'warming' }>


// Base session types that all providers implement. The shell and main
// process only interact with sessions through these types — never
// through provider-specific session classes directly.
//
// Why these live in shared/ instead of in each provider:
//   The shell (workspaceStore, sessionManager, IPC handlers) needs to
//   talk about sessions generically. These types are the contract.
//   Provider-specific session classes implement/extend them.

export type SessionOptions = {
  cwd: string
  cols?: number
  rows?: number
  binary?: string
  env?: Record<string, string | undefined>
  snapshotIntervalMs?: number
  resumeSessionId?: string
  dangerousMode?: boolean
  /** Stable Agent Code session id assigned by SessionManager. Provider
   *  runtimes can use this for app-owned artifact storage paths
   *  without coupling themselves to the manager implementation. */
  shellSessionId?: string
  /** Opt-in mitmproxy-backed transport capture. Currently only the
   *  Claude provider honors this — Codex ignores it. Declared here
   *  (rather than cast inline at the spawn site) so the contract is
   *  visible to every provider and TypeScript doesn't silently lose
   *  the field the next time the spawn shape changes. */
  useProxy?: boolean
  /** Per-process MCP server configs minted by main for built-in Agent Code
   *  domains. Providers only receive concrete launch material (URL + headers),
   *  never the long-lived domain policy; the renderer/session metadata remains
   *  the source of truth for which domains should be enabled. */
  builtInMcpServers?: BuiltInMcpServerConfig[]
}

export type SessionInfo = {
  /**
   * WHY this shared type is the source of truth:
   * preload, renderer resume UI, provider listers, and main registries all pass
   * these records across process/module boundaries. Local copies drift silently
   * because most fields are optional and UI call sites usually touch only one or
   * two of them. Keep new metadata here first, then let provider-specific
   * listers populate the same contract instead of redefining compatible-looking
   * shadows.
   */
  sessionId: string
  summary: string
  lastModified: number
  fileSize: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  createdAt?: number
}
