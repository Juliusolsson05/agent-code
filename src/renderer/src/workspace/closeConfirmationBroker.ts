import type { CloseConfirmationRequest } from '@renderer/workspace/closeConfirmation'

// ---------------------------------------------------------------------------
// The bridge between a close ACTION and the confirmation DIALOG.
//
// The problem this solves: `closeFocused` is an async action inside a hook. It
// needs to stop, ask, and continue with the answer. React state alone cannot
// express that — a component renders the dialog, but the action needs a value
// back, and threading a resolver through the store would put a non-serializable
// function into zustand.
//
// So the store holds the REQUEST (plain data, renderable), and this module
// holds the pending resolver (a function, deliberately outside the store). The
// action awaits a promise; the dialog resolves it.
//
// WHY module scope rather than a ref: the requester and the responder live in
// different component trees — an action inside the workspace hook and a surface
// mounted at the app root. A ref would have to be threaded through both.
// ---------------------------------------------------------------------------

export type PendingCloseConfirmation = {
  request: Extract<CloseConfirmationRequest, { required: true }>
}

type Listener = (pending: PendingCloseConfirmation | null) => void

let pending: PendingCloseConfirmation | null = null
let resolver: ((confirmed: boolean) => void) | null = null
const listeners = new Set<Listener>()

function emit(): void {
  for (const listener of listeners) listener(pending)
}

export function subscribeToCloseConfirmation(listener: Listener): () => void {
  listeners.add(listener)
  listener(pending)
  return () => {
    listeners.delete(listener)
  }
}

export function currentCloseConfirmation(): PendingCloseConfirmation | null {
  return pending
}

/**
 * Ask the user, and resolve to their answer.
 *
 * A second request while one is open resolves the FIRST as declined rather than
 * dropping it. An abandoned promise would leave its close path awaiting
 * forever, which presents as a pane that will not close and no error anywhere —
 * far worse than a refusal the user can retry.
 */
export function requestCloseConfirmation(
  request: PendingCloseConfirmation['request'],
): Promise<boolean> {
  // Resolve the superseded request BEFORE clearing the slot, then install the
  // new resolver BEFORE notifying listeners. The earlier order emitted while
  // `resolver` still pointed at the already-resolved function, so a listener
  // that resolved synchronously during emit() would have hung the new promise.
  // Only a React setState listens today, which cannot — but the ordering should
  // not depend on that.
  const previous = resolver
  resolver = null
  previous?.(false)

  return new Promise<boolean>(resolve => {
    resolver = resolve
    pending = { request }
    emit()
  })
}

/** Answer the open request. Safe to call with nothing pending. */
export function resolveCloseConfirmation(confirmed: boolean): void {
  const resolve = resolver
  pending = null
  resolver = null
  emit()
  resolve?.(confirmed)
}

/** Test seam: module state must not leak between tests. */
export function __resetCloseConfirmationForTests(): void {
  resolver?.(false)
  pending = null
  resolver = null
  listeners.clear()
}
