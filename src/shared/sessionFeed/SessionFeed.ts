import type {
  ConditionCustomAction,
  ResolveConditionResult,
  SessionConditionsEvent,
  SessionExitEvent,
  SessionJsonlEntriesEvent,
  SessionJsonlErrorEvent,
  SessionInputReadinessEvent,
  SessionProcessStateEvent,
  SessionScreenEvent,
  SessionSemanticEvent,
  SessionStartedEvent,
  SessionSubAgentsEvent,
  Unsub,
} from '@shared/sessionFeed/types.js'
import type { PromptDeliveryResult } from '@shared/types/providerConfig.js'

// Convenience re-export: implementations import the contract and its return
// type from one module (types.ts stays the declaration home).
export type { Unsub } from '@shared/sessionFeed/types.js'

// SessionFeed — THE seam between "the UI wants live session I/O" and "where
// that data physically comes from".
//
// Two implementations exist (or will):
//   - IpcSessionFeed (src/renderer/features/sessionFeed/): the desktop app,
//     delegating to the flat `window.api.*` preload bridge.
//   - WebSocketSessionFeed (src/remote-client/, phase 1 of the remote mobile
//     companion): the phone web client, speaking the remote WS protocol.
//
// This interface is the ONLY type-level coupling the isolation boundary in
// docs/superpowers/specs/2026-07-06-remote-mobile-companion-design.md
// permits between core and the remote subsystem. Widening it is how remote
// gains capability; remote code importing anything else from core is a
// boundary violation.
//
// WHY listeners are global (fire for ALL sessions; callers dispatch by
// `sessionId` in the callback) instead of per-session subscribe(sessionId):
// this mirrors the existing one-listener-per-event-type shape in
// useIpcSubscriptions — main can run N sessions in parallel, and a single
// listener per type avoids N×N listener storms as tabs and splits grow.
// Switching to per-session subscription would be a behavioural rewrite of
// the 2000-line subscription hub, out of scope for the phase-0 decoupling;
// a WS transport can still fan per-session frames on the wire and present
// them through this global shape. (Divergence from the spec's sketch is
// deliberate and documented in the phase-0 plan self-review.)
//
// WHY the command surface is exactly these three methods: they are the v1
// remote scope — send prompt text, submit/interrupt (control bytes travel
// through sendInput), and resolve provider condition prompts (permission /
// trust / question dialogs). Session lifecycle (spawn/kill), raw terminal
// I/O, and provider switching are deliberately ABSENT so a remote transport
// cannot express them; scope is enforced by the contract's shape, not by
// runtime checks. Desktop-only surfaces (ghost journal, git worktrees,
// feed-debug, LSP, editor FS) stay on `window.api` — they are not session
// I/O and the phone must never need them.
export interface SessionFeed {
  // --- Listeners (subscribe once; dispatch by sessionId in the callback) ---
  onSessionStarted(cb: (e: SessionStartedEvent) => void): Unsub
  onSessionInputReadiness(cb: (e: SessionInputReadinessEvent) => void): Unsub
  onSessionScreen(cb: (e: SessionScreenEvent) => void): Unsub
  onSessionJsonlEntries(cb: (e: SessionJsonlEntriesEvent) => void): Unsub
  onSessionJsonlError(cb: (e: SessionJsonlErrorEvent) => void): Unsub
  onSessionSemanticEvent(cb: (e: SessionSemanticEvent) => void): Unsub
  onSessionConditions(cb: (e: SessionConditionsEvent) => void): Unsub
  onSessionProcessState(cb: (e: SessionProcessStateEvent) => void): Unsub
  onSessionSubAgents(cb: (e: SessionSubAgentsEvent) => void): Unsub
  onSessionExit(cb: (e: SessionExitEvent) => void): Unsub

  // --- Commands (the v1 remote-allowed input surface) ---

  /** Write bytes to the session's input. For PTY-backed agents this is
   *  keystrokes (prompt text, `\r` submit, `\x1b` interrupt, bracketed
   *  paste). `pasteId` correlates paste writes against the per-paste
   *  debug journal in main — omit for non-paste writes. */
  sendInput(sessionId: string, data: string, pasteId?: string): Promise<boolean>

  /** Deliver a finished prompt to an API-transport agent (opencode) that
   *  has no PTY to receive keystroke bytes. No desktop call site today —
   *  it exists on the contract because the remote client MUST use it for
   *  API-transport sessions, and the preload bridge already exposes it
   *  for the MCP orchestration path. */
  deliverPrompt(
    sessionId: string,
    prompt: string,
    imagePaths?: string[],
    deliveryId?: string,
  ): Promise<PromptDeliveryResult>

  /** Resolve a live provider condition (permission prompt, trust dialog,
   *  AskUserQuestion, codex approval) with a custom action. */
  resolveCondition(
    sessionId: string,
    action: ConditionCustomAction,
  ): Promise<ResolveConditionResult>
}
