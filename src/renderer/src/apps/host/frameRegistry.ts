// The bridge from a host command to the extension's LIVE frame (Group A).
//
// WHY this exists: after the activation model was unified onto the iframe, an
// extension runs in exactly one place — its frame — and NOT in the host realm. So
// "invoke contributed command timer.start" can no longer call a host-side handler
// (there is none); it must be delivered INTO the frame that is currently showing
// the extension. The frame is created deep inside a viewBridge component instance,
// while the command's `run` closure lives in derive.ts with no handle to it. This
// module is the small, explicit rendezvous between the two: a viewBridge registers
// its frame's dispatcher here on ready, and derive.ts looks it up when a command
// fires.
//
// WHY a module singleton and not React context: the command `run` closures are
// built by deriveExtensionCommands (a plain function, not a hook) and invoked from
// the palette/keybind router, neither of which sits inside the provider tree at the
// call site. A singleton keyed by extension id is the honest shape; identity is the
// extension id the frame was minted for.

/** Sends one contributed command id into an extension's frame. */
type FrameDispatch = (commandId: string) => void

// ── A STACK PER EXTENSION, NOT A SINGLE ENTRY ──
// This was a `Map<extensionId, dispatch>` whose comment asserted "there is at most
// one visible frame per extension". The pane path broke that assumption the moment
// it landed: openExtensionViewInPane always splits a NEW leaf, and a pane and a
// modal of the same extension are explicitly designed to coexist. So a second frame
// silently overwrote the first's dispatcher — and because clearFrameDispatch only
// removes an entry still pointing at the disposing frame, closing the NEWER frame
// deleted the entry outright while an older live frame was still on screen. The
// extension then looked dead: dispatchToFrame returned false, and the command
// handler responded by opening yet another pane.
//
// A stack fixes both directions. The most recently readied frame receives commands,
// which is the one the user just interacted with; when it goes away, the next live
// frame down inherits, instead of the extension going deaf.
const dispatchers = new Map<string, FrameDispatch[]>()

// Commands fired while no frame is open. The command opens the extension's view to
// bring a frame up, and these flush the instant that frame signals ready — so
// "timer.start" from a cold palette opens the timer AND starts it, rather than
// silently dropping because the frame did not exist yet. A short-lived buffer, not
// durable state: if the frame never comes up, the intent is discarded, which is the
// correct outcome for a UI action nobody is watching.
const pending = new Map<string, string[]>()

/**
 * A frame announces it is ready to receive commands. Flushes anything queued for
 * this extension immediately, in order.
 */
export function setFrameDispatch(extensionId: string, dispatch: FrameDispatch): void {
  const stack = dispatchers.get(extensionId) ?? []
  // Pushed last = receives commands. Filtered first so a frame that somehow
  // re-announces readiness moves to the top rather than appearing twice.
  dispatchers.set(extensionId, [...stack.filter(entry => entry !== dispatch), dispatch])

  const queued = pending.get(extensionId)
  if (queued && queued.length > 0) {
    pending.delete(extensionId)
    for (const commandId of queued) dispatch(commandId)
  }
}

/**
 * A frame is tearing down. Removes only ITS OWN dispatcher, leaving any other live
 * frame of the same extension registered — so closing one of two open views does
 * not deafen the survivor, and a slow unmount cannot unregister the frame that
 * replaced it.
 */
export function clearFrameDispatch(extensionId: string, dispatch: FrameDispatch): void {
  const stack = dispatchers.get(extensionId)
  if (!stack) return
  const next = stack.filter(entry => entry !== dispatch)
  if (next.length === 0) dispatchers.delete(extensionId)
  else dispatchers.set(extensionId, next)
}

/**
 * Send a command into the extension's live frame. Returns false when no frame is
 * open, so the caller can decide whether to bring one up and queue the command.
 */
export function dispatchToFrame(extensionId: string, commandId: string): boolean {
  const stack = dispatchers.get(extensionId)
  const dispatch = stack?.[stack.length - 1]
  if (!dispatch) return false
  dispatch(commandId)
  return true
}

/**
 * Buffer a command to run as soon as a frame for this extension registers. Caller
 * is expected to also open the extension's view so a frame actually comes up;
 * without that the buffer is simply never flushed.
 */
export function queuePendingCommand(extensionId: string, commandId: string): void {
  const queued = pending.get(extensionId)
  if (queued) queued.push(commandId)
  else pending.set(extensionId, [commandId])
}
