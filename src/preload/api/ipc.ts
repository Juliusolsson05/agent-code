import { ipcRenderer } from 'electron'

import type { Unsub } from '@preload/api/types.js'

// Generic IPC subscription helper.
//
// Each onX method on the bridge delegates to subscribe(channel, cb)
// and returns the resulting Unsub. This keeps domain modules tiny —
// they don't each reimplement "add a listener, return a remover."
//
// Why one listener per caller (not multiplexed):
//   Most onX consumers subscribe once at app mount with a single
//   callback that dispatches by sessionId. ipcRenderer.on fans the
//   event out to every registered listener cheaply; we don't need a
//   dedupe layer here. The ONE case that needs multiplexing is LSP
//   diagnostics (see ./lsp.ts) — a set-of-subscribers pattern that
//   survives hot-module reloads without leaking N IPC listeners.

export function subscribe<T>(channel: string, cb: (payload: T) => void): Unsub {
  const listener = (_evt: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}
