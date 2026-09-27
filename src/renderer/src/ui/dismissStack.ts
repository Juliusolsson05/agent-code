import { useEffect, useRef } from 'react'

/**
 * One stack of open floating surfaces, so Escape dismisses only the TOPMOST
 * one and the app can ask whether any surface is open (#512; the WAI-ARIA APG
 * dialog pattern's "Escape closes the dialog on top").
 *
 * WHY a stack at all: Escape arbitration today is Radix's own layer stack (for
 * Radix dialogs and menus only), plus branches in useKeybinds for a hardcoded
 * list of surfaces, plus per-component handlers. A surface outside the first
 * two either ignores Escape or closes together with the one under it, and
 * useKeybinds can only suppress global shortcuts under the surfaces it names.
 * `anySurfaceOpen()` is the predicate that generalises that bailout.
 *
 * SEQUENCING (steering q95): this module ships UNWIRED. W1's #1394 edits
 * useKeybinds.ts and owner keyboard work is in flight, so the capture-phase
 * Escape handler and the useKeybinds bailout switch to this stack in a
 * follow-up on a fresh origin/main once #1394 merges. Until then nothing
 * registers here, and nothing reads it.
 *
 * Contract for the wiring:
 *  - A surface registers while it is open (`useDismissLayer`); order of
 *    registration is stacking order, which matches how surfaces open.
 *  - The single document capture listener calls `dismissTopmost(event)` on
 *    Escape and stops the event if it returns true.
 *  - An event already handled (`defaultPrevented`) is left alone: the
 *    AskUserQuestion row forwards Escape to the provider's PTY and must keep
 *    doing so.
 *  - A surface can refuse Escape while busy (`escapeEnabled` false, e.g. a
 *    bulk provider switch mid-flight). It still CONSUMES the key: letting it
 *    fall through would close the surface underneath, which is worse.
 */
type Layer = {
  onDismiss: () => void
  escapeEnabled: () => boolean
}

const layers: Layer[] = []

/** Register an open surface. Returns its release, which is idempotent and
 *  may be called in any order (a lower surface can close first). */
export function pushDismissLayer(layer: { onDismiss: () => void; escapeEnabled?: () => boolean }): () => void {
  const entry: Layer = { onDismiss: layer.onDismiss, escapeEnabled: layer.escapeEnabled ?? (() => true) }
  layers.push(entry)
  return () => {
    const at = layers.indexOf(entry)
    if (at >= 0) layers.splice(at, 1)
  }
}

/** True while any registered surface is open. */
export function anySurfaceOpen(): boolean {
  return layers.length > 0
}

/**
 * Escape: dismiss the topmost surface. Returns true when the key was
 * consumed (the caller should stop it), false when there is no surface or
 * someone already handled the event.
 */
export function dismissTopmost(event?: { defaultPrevented?: boolean }): boolean {
  if (event?.defaultPrevented) return false
  const top = layers.at(-1)
  if (!top) return false
  if (top.escapeEnabled()) top.onDismiss()
  return true
}

/**
 * Register a surface for as long as `open` is true. The latest callbacks are
 * read at dismissal time, so a re-render does not re-register (which would
 * move the surface to the top of the stack).
 */
export function useDismissLayer(
  open: boolean,
  onDismiss: () => void,
  options: { escapeEnabled?: boolean } = {},
): void {
  const latest = useRef({ onDismiss, escapeEnabled: options.escapeEnabled ?? true })
  latest.current = { onDismiss, escapeEnabled: options.escapeEnabled ?? true }
  useEffect(() => {
    if (!open) return
    return pushDismissLayer({
      onDismiss: () => latest.current.onDismiss(),
      escapeEnabled: () => latest.current.escapeEnabled,
    })
  }, [open])
}

/** Test-only: the number of registered surfaces. */
export function dismissLayerCountForTest(): number {
  return layers.length
}
