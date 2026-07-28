import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'

export type ComposerEnterTargetHandle = {
  focused: boolean
  hovered: boolean
  hasSubmittableDraft: () => boolean
  focus: () => void
  submit: () => void
}

const targets = new Set<ComposerEnterTargetHandle>()
let keydownListener: ((event: KeyboardEvent) => void) | null = null

function targetElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target : null
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = targetElement(target)
  if (!element) return false
  const tag = element.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || element.isContentEditable
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  const element = targetElement(target)
  if (!element) return false
  const tag = element.tagName
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'SUMMARY') {
    return true
  }
  return Boolean(
    element.closest(
      'button,a[href],select,summary,[role="button"],[role="link"],[role="menuitem"],[role="option"],[tabindex]:not([tabindex="-1"])',
    ),
  )
}

// WHY this carve-out exists: a Dispatch index row is a <button>, so
// isInteractiveTarget() classifies it as a real action element and the keydown
// handler bails before it can hand Enter to a composer. But a Dispatch row is
// NOT a real action button in the Enter sense — clicking it only *selects* a
// session (focusSessionInTab), and pressing Enter again to re-select is a
// no-op. So when the active pane already has a submittable draft, the user's
// Enter clearly means "send my draft," not "re-select the row I just clicked."
// The row carries data-dispatch-row="true" (DispatchAgentList / DispatchMiniList)
// precisely so this router can tell it apart from a genuine action button and
// relax the interactive guard for it alone. See issue #236.
function isDispatchRowTarget(target: EventTarget | null): boolean {
  const element = targetElement(target)
  if (!element) return false
  return Boolean(element.closest('[data-dispatch-row="true"]'))
}

function hasOpenKeyboardOwner(): boolean {
  if (hasAppInteractionOwner()) return true
  return Boolean(
    document.querySelector(
      '[role="menu"],[role="listbox"]',
    ),
  )
}

function pickTarget(): ComposerEnterTargetHandle | null {
  let focused: ComposerEnterTargetHandle | null = null
  for (const target of targets) {
    // WHY hovered wins over focused: the exact failure this registry fixes is
    // "my visible draft is under the pointer, but DOM focus wandered." If the
    // user has moved the mouse to another composer, that is a more concrete
    // intent than the last command-focused pane. There can only be one real
    // pointer hover at a time, while focus can lag behind pane navigation.
    //
    // WHY an empty hovered composer returns null instead of falling through:
    // once the pointer is over a composer, Enter should apply to that composer
    // or to nothing. Submitting some other focused pane would make hover intent
    // feel like a trap, especially when speech-to-text left a draft elsewhere.
    if (target.hovered) return target.hasSubmittableDraft() ? target : null
    if (!target.hasSubmittableDraft()) continue
    if (!focused && target.focused) focused = target
  }
  return focused
}

function ensureListener(): void {
  if (keydownListener) return
  keydownListener = event => {
    if (event.defaultPrevented) return
    if (event.key !== 'Enter') return
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    if (isEditableTarget(event.target)) return

    // WHY the interactive guard now skips Dispatch rows: a real action button
    // or link must keep its native Enter (activating it). A Dispatch row only
    // selects a session, so re-activating it via Enter is meaningless — the
    // composer should win instead. We therefore exempt Dispatch rows from the
    // interactive bail-out here and let pickTarget() decide below. Every other
    // interactive target still returns, so this relaxation is scoped to
    // Dispatch rows alone. See issue #236.
    if (isInteractiveTarget(event.target) && !isDispatchRowTarget(event.target)) {
      return
    }

    // Modals / menus / listboxes own the keyboard while open; never steal Enter
    // from them, even when the focus happens to be a Dispatch row underneath.
    if (hasOpenKeyboardOwner()) return

    // pickTarget() returns null when there is no submittable draft (empty
    // composer, or the focused composer is in slash-command mode). For a
    // Dispatch row that means we fall through WITHOUT preventDefault, so the
    // row keeps its native Enter behaviour (a harmless re-select). The draft is
    // only intercepted when one actually exists.
    const target = pickTarget()
    if (!target) return
    // preventDefault() here also suppresses the Dispatch row button's native
    // Enter→click, so onSelect (focusSessionInTab) does NOT also fire when we
    // redirect Enter to the composer. Without this the row would re-select at
    // the same time the draft submits.
    event.preventDefault()
    target.focus()
    target.submit()
  }
  document.addEventListener('keydown', keydownListener)
}

/**
 * Submit the composer the Enter router would have submitted, from a command.
 *
 * WHY this lives here rather than on `workspace`: `submit` is owned by the
 * registered handle, not by the store — TileLeaf builds it from
 * `submitCurrentDraft`, which closes over provider capabilities, the
 * optimistic-echo rollback and the in-flight latch. Re-deriving any of that in
 * a command would be a second submit path, which is the class of bug the whole
 * registry exists to prevent.
 *
 * Deliberately reuses `pickTarget()` unchanged, so a command submits the SAME
 * composer a bare Enter would have: hovered wins over focused, and an empty
 * hovered composer resolves to nothing rather than falling through to some
 * other pane. A command that picked differently from Enter would be a subtly
 * different feature wearing the same name.
 *
 * Returns false when there was nothing to submit, so the caller can stay quiet
 * instead of reporting a success that did not happen.
 */
export function submitActiveComposer(): boolean {
  const target = pickTarget()
  if (!target) return false
  target.focus()
  target.submit()
  return true
}

export function registerComposerEnterTarget(
  handle: ComposerEnterTargetHandle,
): () => void {
  targets.add(handle)
  ensureListener()
  return () => {
    targets.delete(handle)
    if (targets.size === 0 && keydownListener) {
      document.removeEventListener('keydown', keydownListener)
      keydownListener = null
    }
  }
}
