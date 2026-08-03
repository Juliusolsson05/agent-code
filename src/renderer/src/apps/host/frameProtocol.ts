import { z } from 'zod'

// The host <-> extension-frame message contract (WS4, sandbox substrate).
//
// THE INVARIANT, borrowed verbatim from the remote mobile protocol
// (main/remote/protocol/messages.ts): the request union below is the COMPLETE
// set of things a sandboxed extension can ask the host to do. Anything not in it
// is unrepresentable, not "checked and denied". Widening it is a deliberate
// capability decision.
//
// WHY this exists at all — the isolation model (Decision A). An extension view is
// a plain <iframe src="agent-code-ext://<id>/..."> in the app's renderer. Because
// the scheme is a real, distinct origin (scheme.ts registers it `standard: true`),
// the child document is same-process but cross-ORIGIN: it cannot reach `window.api`,
// the parent DOM, or another extension. Its ONLY channel to the host is
// `window.postMessage`. So the frame never holds a capability; it posts a request,
// and the parent host — the trusted broker — performs it with the real API and
// posts back a reply.
//
// WHY identity is NOT a field in the message. The remote protocol carries a device
// `token` because a socket cannot otherwise be attributed. A frame can: the browser
// stamps `event.origin` on every postMessage, and it is unforgeable by the child.
// The host derives WHICH extension sent a request from that origin
// (`extensionIdFromOrigin`), never from anything the child claims. This is the
// whole reason the sandbox turns the storage namespace into a real authority
// boundary (see ipc/extensions.ts's "namespace, not authority" comment — this is
// the "Stage 2" it defers to).

// --- Requests (frame -> host) ------------------------------------------------
// One per Tier-0 AgentCodeApiV1 method. Kept flat + discriminated so a malformed
// or out-of-scope request fails the same parse as an unknown one.

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

/**
 * A storage key that cannot collide with Object.prototype machinery.
 *
 * `storage.ts` does `data[key] = value` on a JSON.parse result. With key `__proto__`
 * that hits Object.prototype's setter instead of creating an own property: on a fresh
 * store the write silently vanishes and keys() never lists it, while on a store whose
 * JSON literally contained "__proto__" it behaves completely differently. Not
 * exploitable — Object.prototype is never mutated — but it is silent, state-dependent
 * data loss, and an extension author would have no way to diagnose it. Reject loudly.
 */
const SAFE_STORAGE_KEY = z
  .string()
  .min(1)
  .max(256)
  .refine(k => k !== '__proto__' && k !== 'constructor' && k !== 'prototype', {
    message: 'key may not be __proto__, constructor, or prototype',
  })

export const frameRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('storage.get'), key: SAFE_STORAGE_KEY }),
  z.object({
    method: z.literal('storage.set'),
    key: SAFE_STORAGE_KEY,
    value: jsonValueSchema,
  }),
  z.object({ method: z.literal('storage.delete'), key: SAFE_STORAGE_KEY }),
  z.object({ method: z.literal('storage.keys') }),
  z.object({ method: z.literal('ui.close') }),
  z.object({ method: z.literal('ui.showToast'), message: z.string().min(1).max(2000) }),
  z.object({ method: z.literal('theme.tokens') }),
  // Tier-1 observe reads. No arguments — each returns a snapshot. The broker gates
  // these on the extension's grant before performing (Tier-0 above is ungated).
  z.object({ method: z.literal('workspace.observe') }),
  z.object({ method: z.literal('sessions.observe') }),
  z.object({ method: z.literal('panes.observe') }),
])

/**
 * Every request carries a child-minted `id` the host echoes on the reply, so the
 * extension can correlate responses over the single postMessage channel. A `kind`
 * tag namespaces our frames away from any other postMessage traffic sharing
 * `window` — an unrelated message (a library's, a devtools bridge's) fails this
 * parse and is ignored rather than misread as a request.
 */
export const frameRequestEnvelopeSchema = z.object({
  kind: z.literal('agent-code-ext:request'),
  id: z.string().min(1).max(200),
  request: frameRequestSchema,
})

export type FrameRequest = z.infer<typeof frameRequestSchema>
export type FrameRequestEnvelope = z.infer<typeof frameRequestEnvelopeSchema>

// --- Replies + pushes (host -> frame) ----------------------------------------
// These are produced by the trusted host, so they are TYPES, not runtime-parsed
// schemas — the child validates them only as much as its own SDK chooses to. The
// host is not a boundary the host must defend against.

export type FrameReply =
  | { kind: 'agent-code-ext:reply'; id: string; ok: true; result: unknown }
  | { kind: 'agent-code-ext:reply'; id: string; ok: false; error: string }

/**
 * Host-initiated messages that are not replies to a request.
 * - `mount`: the host tells the child which view to render into its document, the
 *   frame equivalent of calling `ViewMount(element)` in the same-realm model.
 * - `theme`: theme tokens pushed on change, because the CSS cascade does not cross
 *   the frame boundary — the same values `api.theme.tokens()` returns.
 * - `command`: invoke a contributed command's handler INSIDE the frame. After the
 *   activation model was unified onto the iframe (Group A), the extension's command
 *   handlers live only in the frame, so the palette/keybind router delivers an
 *   invocation here rather than running a host-side handler. Unlike a request there
 *   is no reply — a command is fire-and-forget from the host's side; the frame owns
 *   the outcome (and reports failures to its own console).
 */
export type FramePush =
  | { kind: 'agent-code-ext:mount'; viewId: string }
  | { kind: 'agent-code-ext:theme'; tokens: Record<string, string> }
  | { kind: 'agent-code-ext:command'; commandId: string }
  // A change NUDGE for a Tier-1 observe topic (workspace/sessions/panes). Carries no
  // data on purpose: the child re-reads via the grant-gated observe() call, so a
  // nudge can never leak host state to an extension that lacks the capability — the
  // re-read would be denied. This makes observe live without duplicating the
  // snapshot projection or widening what crosses the boundary.
  | { kind: 'agent-code-ext:event'; topic: string }

// --- Identity ----------------------------------------------------------------

/**
 * The extension id that owns a frame, derived from its unforgeable origin.
 *
 * A frame served from `agent-code-ext://timer/view.html` has origin
 * `agent-code-ext://timer`; the host part is the extension id. Returns null for
 * any origin that is not this scheme or whose id does not match the install-time
 * id grammar — a request from an unexpected origin is dropped, never attributed to
 * a guessed extension. The grammar is duplicated from manifest.ts/storage.ts on
 * purpose (each owns the check at its own boundary); a mismatch here would let a
 * malformed origin address a storage namespace, so the same regex guards it.
 */
export function extensionIdFromOrigin(origin: string): string | null {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return null
  }
  if (url.protocol !== 'agent-code-ext:') return null
  const id = url.hostname
  return /^[a-z][a-z0-9-]{0,63}$/.test(id) ? id : null
}
