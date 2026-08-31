// deliverWithWake — recover a prompt delivery that main rejected because the
// backend for this pane does not exist in this app run (#706).
//
// THE FAILURE THIS REPAIRS. `deliverPromptToAgent` rejects at `before-write`
// with `code: 'not-ready'` when its registry holds no live agent entry for the
// session id — journaled as `reason: "never-owned"` (an id main never spawned
// this run: a pane restored from workspace.json after a restart) or
// `"entry-lost-after-owned"` (a teardown the renderer missed). Both paint the
// same user-visible symptom on a healthy-looking pane:
//
//   "Cannot deliver prompt: <id> is not a live agent session"
//
// Recorded in debug bundle 2026-08-30T23-51-06-471-9bd68e14: after a
// force-quit restart, the first Enter into a restored pane hit a backend
// nothing had respawned — rehydrate deliberately does not respawn detached
// sessions, TileLeaf.send wakes only the RAW-WRITE path (which the
// Claude/opencode delivery protocol never touches; Codex submits are raw
// sends and already covered), and #691's lane-selection wake fires only on
// placement GESTURES, which a restored workspace never performs.
//
// WHY REACT TO MAIN'S VERDICT INSTEAD OF GATING ON RENDERER STATE: this
// failure IS registry split-brain — the renderer believing the pane is live is
// the broken half of the state. A proactive `runtime.processStatus` gate would
// consult exactly the component that is already wrong. Main's reject is
// authoritative and already carries the recovery contract: `retrySafe: true`
// plus `disposition: 'session-unusable'` at `before-write` proves zero bytes
// reached any PTY and the session needs repair, so one wake + one retry cannot
// duplicate anything.
//
// WHY EXACTLY ONE RETRY: `ensureSessionLive` recovers under the SAME SessionId
// (joining any in-flight wake), so if the retry still says `not-ready`, the
// backend refused to come back and looping would just hammer a dead pane —
// surface the failure and let the pane's existing Retry affordance own it.

import type { PromptDeliveryResult } from '@shared/types/providerConfig'

// The one failure shape that proves "backend missing, nothing written, safe to
// try again". Everything else — delivery-in-flight, absorption/acceptance
// trouble, do-not-retry post-write uncertainty — belongs to the existing
// failure UX (unwind, toasts, the uncertain banner) untouched.
function backendNeedsWake(result: PromptDeliveryResult): boolean {
  return (
    !result.ok &&
    result.stage === 'before-write' &&
    result.code === 'not-ready' &&
    result.retrySafe &&
    result.disposition === 'session-unusable'
  )
}

export async function deliverWithWake(
  deliver: () => Promise<PromptDeliveryResult>,
  wake: () => Promise<unknown>,
): Promise<PromptDeliveryResult> {
  const first = await deliver()
  if (!backendNeedsWake(first)) return first
  try {
    await wake()
  } catch {
    // The wake path already narrates its own failure (pane toast, runtime
    // `failed` state). Returning main's original verdict keeps one owner for
    // the delivery-failure UX instead of inventing a second message here.
    return first
  }
  return deliver()
}
