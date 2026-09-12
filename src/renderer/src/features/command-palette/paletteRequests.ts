// A small feature-owned rendezvous for opening the real lazy palette. It has
// no SDK/MCP dependency: the UI consumes a request and acknowledges its rendered
// state; the optional control registration translates that into tool results.
// Keeping query/selection local avoids subscribing the whole app to keystrokes.
export type PaletteOpenResult = {
  query: string; selectedCommandId: string | null; requestedSelectionFound: boolean; visibleRows: number
}
export type PaletteOpenRequest = { id: string; query: string; commandId?: string }
let pending: PaletteOpenRequest | null = null
let settle: ((result: PaletteOpenResult) => void) | undefined
const listeners = new Set<() => void>()
export const paletteRequests = {
  snapshot: () => pending,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  open(input: Omit<PaletteOpenRequest, 'id'>): Promise<PaletteOpenResult> {
    if (pending) return Promise.reject(new Error('Another picker request is in progress'))
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const timeout = setTimeout(() => {
        if (pending?.id !== id) return
        pending = null; settle = undefined
        for (const notify of listeners) notify()
        reject(new Error('Picker did not acknowledge its rendered state; inspect the UI before retrying'))
      }, 10_000)
      settle = result => { clearTimeout(timeout); resolve(result) }
      pending = { id, ...input }
      for (const notify of listeners) notify()
    })
  },
  acknowledge(id: string, result: PaletteOpenResult) {
    if (pending?.id !== id) return
    const finish = settle
    pending = null; settle = undefined
    finish?.(result)
    for (const notify of listeners) notify()
  },
}
