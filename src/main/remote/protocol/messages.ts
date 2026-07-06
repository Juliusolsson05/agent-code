import { z } from 'zod'

// Wire schemas for the remote mobile companion's WebSocket protocol.
//
// THE INVARIANT THIS FILE ENFORCES (spec §"Scope for v1"): the inbound
// union below is the COMPLETE set of things a phone can make this machine
// do. Shell execution, session spawn/kill, provider switching, and raw
// keystroke input are not "checked and denied" — they are unrepresentable,
// because no schema for them exists. A stolen device token is limited to
// prompting agents and answering their condition dialogs. Widening this
// union is a deliberate security decision that belongs in its own PR with
// scope.test.ts updated in the same diff.
//
// WHY zod at the boundary instead of TypeScript types + trust: every frame
// arrives from a network socket that any device on the LAN (or, with the
// phase-2 tunnel, the internet) can open. Types don't exist at runtime;
// these schemas are the runtime teeth. RemoteServer parses with
// parseInboundFrame (scope.ts) BEFORE any handler sees the payload.

// --- Inbound (phone → Mac) ---------------------------------------------------

/** Liveness probe; also what the client sends to keep NAT/proxy sockets warm. */
export const pingMessageSchema = z.object({
  type: z.literal('ping'),
})

/**
 * Deliver prompt text to a session's composer path. `text` is REQUIRED
 * non-empty: an empty prompt is meaningless and, on PTY providers, a bare
 * submit — which has its own explicit message below. Keeping them distinct
 * makes the server-side apply logic total (no "was this a submit?" guessing).
 */
export const sendPromptMessageSchema = z.object({
  type: z.literal('send-prompt'),
  sessionId: z.string().min(1),
  text: z.string().min(1),
})

/** Press Enter — submit whatever is staged in the session's input. */
export const submitMessageSchema = z.object({
  type: z.literal('submit'),
  sessionId: z.string().min(1),
})

/** Interrupt the running turn (Esc — the provider TUIs' universal stop). */
export const interruptMessageSchema = z.object({
  type: z.literal('interrupt'),
  sessionId: z.string().min(1),
})

/**
 * Answer a live provider condition (permission prompt, trust dialog,
 * AskUserQuestion, codex approval). The action mirrors ConditionAction from
 * @shared/conditions-core/contract — re-modeled here as zod because that
 * contract is compile-time only.
 *
 * A `pty` action's `data` is raw keystrokes, which sounds like the raw-input
 * hole the v1 scope amputated — it is not, for two reasons enforced by
 * RemoteServer at apply time: (1) the action must match one of the LIVE
 * condition's own offered actions (id + data equality against the current
 * snapshot), so the phone can only pick from choices the provider itself
 * put on screen; (2) sessions without a live condition reject the message
 * outright. The schema alone cannot see the live snapshot, so this pairing
 * of schema + apply-time check is the full guard.
 */
export const conditionActionSchema = z.union([
  z.object({
    kind: z.literal('pty'),
    id: z.string().min(1),
    label: z.string(),
    data: z.string().min(1),
  }),
  z.object({
    kind: z.literal('custom'),
    id: z.string().min(1),
    label: z.string(),
    name: z.string().min(1),
    payload: z.unknown().optional(),
  }),
])

export const permissionReplyMessageSchema = z.object({
  type: z.literal('permission-reply'),
  sessionId: z.string().min(1),
  action: conditionActionSchema,
})

export const inboundMessageSchema = z.discriminatedUnion('type', [
  pingMessageSchema,
  sendPromptMessageSchema,
  submitMessageSchema,
  interruptMessageSchema,
  permissionReplyMessageSchema,
])

/**
 * Every inbound frame carries the device token (verified per-message, not
 * just at upgrade — a socket hijacked after upgrade still can't act) and an
 * optional client-minted id the server echoes on the reply so the phone can
 * correlate request/response over the single socket.
 */
export const inboundFrameSchema = z.object({
  token: z.string().min(1),
  id: z.string().optional(),
  message: inboundMessageSchema,
})

export type InboundMessage = z.infer<typeof inboundMessageSchema>
export type InboundFrame = z.infer<typeof inboundFrameSchema>

// --- Outbound (Mac → phone) --------------------------------------------------
//
// Outbound frames are server-authored, so they don't need runtime parsing on
// this side — the types keep the server honest and give the phone client a
// single import for the whole wire shape. `session-event` deliberately wraps
// payloads as { channel, payload } mirroring the SessionFeed listener names:
// the phone's WebSocketSessionFeed is a switchboard from channel → listener
// set, identical in shape to how the preload bridge fans out IPC channels.

export type OutboundSessionSummary = {
  sessionId: string
  kind: string
  cwd: string | null
  /** Present when the provider session has started; null for spawning/dead. */
  alive: boolean
}

export type OutboundFrame =
  | { type: 'hello'; deviceId: string; deviceName: string }
  | { type: 'pong'; id?: string }
  | { type: 'session-list'; sessions: OutboundSessionSummary[] }
  | {
      type: 'session-event'
      channel:
        | 'started'
        | 'screen'
        | 'jsonl-entries'
        | 'jsonl-error'
        | 'semantic-event'
        | 'conditions'
        | 'process-state'
        | 'sub-agents'
        | 'exit'
      payload: unknown
    }
  | { type: 'reply'; id?: string; ok: boolean; error?: string; result?: unknown }
  | { type: 'error'; error: string }
