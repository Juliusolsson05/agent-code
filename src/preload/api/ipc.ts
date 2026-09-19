import { ipcRenderer } from 'electron'

import type { Unsub } from '@preload/api/types.js'

// Generic IPC subscription helper.
//
// Each onX method on the bridge delegates to subscribe(channel, cb)
// and returns the resulting Unsub. This keeps domain modules tiny —
// they don't each reimplement "add a listener, return a remover."
//
// Why one listener per caller (not multiplexed) by default:
//   Most onX consumers subscribe once at app mount with a single
//   callback that dispatches by sessionId. ipcRenderer.on fans the
//   event out to every registered listener cheaply; we don't need a
//   dedupe layer for those. Channels that every mounted PANE subscribes
//   to use subscribeShared below instead.

export function subscribe<T>(channel: string, cb: (payload: T) => void): Unsub {
  const listener = (_evt: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * One ipcRenderer listener per channel, fanned out to every subscriber.
 *
 * WHY (#1015): some channels are subscribed once per mounted pane
 * (goal-loop:changed from GoalLoopPane, dictation:stream-transcript from each
 * composer). Eleven panes crossed Node's default of 10 listeners, and the dev
 * app warned "Possible EventEmitter memory leak" at every startup. It was not
 * a leak (every pane unsubscribes), but a permanent false alarm hides the
 * next real one. Raising MaxListeners would silence exactly that alarm.
 * LSP diagnostics (./lsp.ts) solved the same problem with its own Set and keeps
 * it on purpose: its listener stays installed for the renderer's lifetime,
 * because code blocks mount and unmount constantly while scrolling. This one
 * removes the relay with its last subscriber.
 *
 * The relay is removed with the last subscriber, so no listener outlives its
 * users. Each subscriber is isolated: one pane that throws must not stop the
 * others from hearing the event, which separate ipcRenderer listeners did not
 * guarantee either (EventEmitter stops at the first throw).
 */
type SharedChannel = { subscribers: Set<(payload: unknown) => void>; relay: (event: unknown, payload: unknown) => void }
const sharedChannels = new Map<string, SharedChannel>()

export function subscribeShared<T>(channel: string, cb: (payload: T) => void): Unsub {
  let shared = sharedChannels.get(channel)
  if (!shared) {
    const subscribers = new Set<(payload: unknown) => void>()
    const relay = (_event: unknown, payload: unknown) => {
      // Copied first: a subscriber may unsubscribe (a pane unmounting in
      // response to the event) while the loop runs.
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(payload)
        } catch (error) {
          console.error(`[ipc] a ${channel} subscriber threw:`, error)
        }
      }
    }
    ipcRenderer.on(channel, relay)
    shared = { subscribers, relay }
    sharedChannels.set(channel, shared)
  }
  // A fresh wrapper per call: the same callback subscribed twice is two
  // subscriptions, each removed by its own Unsub, as with ipcRenderer.on.
  const subscription = (payload: unknown) => cb(payload as T)
  shared.subscribers.add(subscription)
  return () => {
    const current = sharedChannels.get(channel)
    if (!current || !current.subscribers.delete(subscription)) return
    if (current.subscribers.size === 0) {
      ipcRenderer.removeListener(channel, current.relay)
      sharedChannels.delete(channel)
    }
  }
}
