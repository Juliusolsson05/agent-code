// Imperative requests to a live pocket (reload, focus the address bar, pick…).
//
// WHY a bus instead of commands calling the <webview>: commands, main's
// pocket-local chords (⌘R/⌘L/⌘⇧S while the page has focus) and the chrome
// row all ask for the same actions, but only BrowserPocketHost owns the guest
// element. A bus keyed by pocketId keeps the guest private to the host, and a
// request for a pocket with no live guest is simply dropped (the host is the
// only one that knows whether one exists).

export type PocketRequest =
  | { type: 'reload'; hard?: boolean }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'navigate'; url: string }
  | { type: 'focus-address' }
  | { type: 'pick' }
  | { type: 'devtools' }
  | { type: 'open-external' }

type Listener = (pocketId: string, request: PocketRequest) => void
const listeners = new Set<Listener>()

export function requestPocket(pocketId: string, request: PocketRequest): void {
  for (const listener of listeners) listener(pocketId, request)
}

export function onPocketRequest(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
