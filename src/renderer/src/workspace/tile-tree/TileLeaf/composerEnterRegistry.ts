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

function hasOpenKeyboardOwner(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
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
    if (isInteractiveTarget(event.target)) return
    if (hasOpenKeyboardOwner()) return

    const target = pickTarget()
    if (!target) return
    event.preventDefault()
    target.focus()
    target.submit()
  }
  document.addEventListener('keydown', keydownListener)
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
