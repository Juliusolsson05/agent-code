export type ComposerEnterTargetHandle = {
  focused: boolean
  hovered: boolean
  hasSubmittableDraft: () => boolean
  focus: () => void
  submit: () => void
}

const targets = new Set<ComposerEnterTargetHandle>()
let listening = false

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

function pickTarget(): ComposerEnterTargetHandle | null {
  let focused: ComposerEnterTargetHandle | null = null
  for (const target of targets) {
    if (!target.hasSubmittableDraft()) continue
    // WHY hovered wins over focused: the exact failure this registry fixes is
    // "my visible draft is under the pointer, but DOM focus wandered." If the
    // user has moved the mouse to another composer, that is a more concrete
    // intent than the last command-focused pane. There can only be one real
    // pointer hover at a time, while focus can lag behind pane navigation.
    if (target.hovered) return target
    if (!focused && target.focused) focused = target
  }
  return focused
}

function ensureListener(): void {
  if (listening) return
  listening = true
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented) return
    if (event.key !== 'Enter') return
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    if (isEditableTarget(event.target)) return
    if (document.querySelector('[role="dialog"]')) return

    const target = pickTarget()
    if (!target) return
    event.preventDefault()
    target.focus()
    target.submit()
  })
}

export function registerComposerEnterTarget(
  handle: ComposerEnterTargetHandle,
): () => void {
  targets.add(handle)
  ensureListener()
  return () => {
    targets.delete(handle)
  }
}
