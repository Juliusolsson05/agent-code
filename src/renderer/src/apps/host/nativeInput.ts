import { flushSync } from 'react-dom'
import type { ExtensionNativeInput } from '@shared/types/extensionInput'

// One native IPC listener for all views, including legacy v1 frames. The map is
// parent-owned DOM identity, never an extension-supplied view id or window name.
const frames = new Map<HTMLIFrameElement, () => void>()
let unsubscribe: (() => void) | null = null
let focusTimer: ReturnType<typeof setTimeout> | null = null

function focusedFrame(): HTMLIFrameElement | null {
  const active = document.activeElement
  return active instanceof HTMLIFrameElement && frames.has(active) ? active : null
}

function receive(message: ExtensionNativeInput): void {
  const frame = focusedFrame()
  if (!frame || frame.src !== message.url) return
  // React's keyboard listener closes over workspace selection. Commit the
  // selected pane before dispatching Cmd+W or it can close the previous pane.
  flushSync(() => frames.get(frame)?.())
  if (focusedFrame() !== frame || frame.src !== message.url) return
  if (message.kind === 'key') frame.dispatchEvent(new KeyboardEvent(message.type, { ...message.input, bubbles: true, cancelable: true }))
}

function focusChanged(): void {
  if (focusTimer !== null) clearTimeout(focusTimer)
  focusTimer = setTimeout(() => {
    focusTimer = null
    const frame = focusedFrame()
    if (frame) flushSync(() => frames.get(frame)?.())
  }, 0)
}

export function bindExtensionFrameInput(frame: HTMLIFrameElement, focus: () => void): () => void {
  frames.set(frame, focus)
  if (!unsubscribe) {
    // This callback is a preload IPC subscription. There is deliberately no
    // window.message route: a child can forge any postMessage payload it likes.
    unsubscribe = window.api.onExtensionNativeInput(receive)
    window.addEventListener('blur', focusChanged)
    window.addEventListener('focus', focusChanged)
  }
  return () => {
    if (frames.get(frame) === focus) frames.delete(frame)
    if (frames.size === 0) {
      unsubscribe?.(); unsubscribe = null
      window.removeEventListener('blur', focusChanged)
      window.removeEventListener('focus', focusChanged)
      if (focusTimer !== null) clearTimeout(focusTimer)
      focusTimer = null
    }
  }
}
