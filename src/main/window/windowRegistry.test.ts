import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppWindowHooks } from '@main/window/appWindow.js'

type Sent = { channel: string; args: unknown[] }

const built: Array<{ hooks: AppWindowHooks; sent: Sent[]; destroyed: boolean }> = []

vi.mock('electron', () => ({
  // The registry consults the native focused window first and falls back to its
  // own most-recently-focused list. Returning null here exercises the fallback,
  // which is the path that actually matters: a global hotkey or native menu
  // click can arrive while the app is not frontmost.
  BrowserWindow: { getFocusedWindow: () => null },
}))

vi.mock('@main/window/appWindow.js', () => ({
  zoomBrowserWindow: vi.fn(),
  buildAppWindow: (options: { hooks: AppWindowHooks }) => {
    const record = { hooks: options.hooks, sent: [] as Sent[], destroyed: false }
    built.push(record)
    return {
      id: built.length,
      isDestroyed: () => record.destroyed,
      isMinimized: () => false,
      show: vi.fn(),
      focus: vi.fn(),
      webContents: {
        id: built.length,
        send: (channel: string, ...args: unknown[]) => record.sent.push({ channel, args }),
      },
    }
  },
}))

const registry = await import('@main/window/windowRegistry.js')

// Routing is the only defense against a session event reaching the wrong
// window: every session handler in useIpcSubscriptions materializes
// `emptyRuntime()` for an id it does not recognize, so a misrouted event grows
// a ghost runtime rather than being ignored.

describe('window registry routing', () => {
  beforeEach(() => {
    registry.resetWindowRegistryForTests()
    built.length = 0
  })

  it('sends a session event only to the window that owns the session', () => {
    const left = registry.createAppWindow()
    const right = registry.createAppWindow()
    registry.claimSessionForWindow('agent-1', left)
    registry.claimSessionForWindow('agent-2', right)

    registry.sendToSessionWindow('agent-1', 'session:screen', { sessionId: 'agent-1' })

    expect(built[0]?.sent.map(s => s.channel)).toEqual(['session:screen'])
    expect(built[1]?.sent).toEqual([])
  })

  it('broadcasts an unowned session rather than dropping it', () => {
    registry.createAppWindow()
    registry.createAppWindow()

    registry.sendToSessionWindow('nobody', 'session:screen', { sessionId: 'nobody' })

    // A dropped session event silently freezes a pane, which is the worst
    // failure shape this codebase knows. Ownership should make this
    // unreachable; the broadcast exists because that is an argument, not a
    // guarantee.
    expect(built[0]?.sent).toHaveLength(1)
    expect(built[1]?.sent).toHaveLength(1)
  })

  it('moves routing when sessions are transferred to a survivor', () => {
    const closing = registry.createAppWindow()
    const survivor = registry.createAppWindow()
    registry.claimSessionForWindow('agent-1', closing)

    registry.transferSessions(registry.sessionsOwnedBy(closing), survivor)
    registry.sendToSessionWindow('agent-1', 'session:exit', { sessionId: 'agent-1' })

    // Ownership has to move BEFORE the survivor is told about the workspace, or
    // an event emitted mid-handoff routes to a window being torn down.
    expect(built[0]?.sent).toEqual([])
    expect(built[1]?.sent.map(s => s.channel)).toEqual(['session:exit'])
  })

  it('keeps ownership across a natural exit and ends it on an explicit release', () => {
    const window = registry.createAppWindow()
    registry.claimSessionForWindow('agent-1', window)
    // An exited pane is still on screen, still owned, and can be reloaded in
    // place — so `session:exit` must not be the thing that ends ownership.
    registry.sendToSessionWindow('agent-1', 'session:exit', { sessionId: 'agent-1' })
    expect(registry.windowForSession('agent-1')).toBe(window)

    registry.releaseSession('agent-1')
    expect(registry.windowForSession('agent-1')).toBeNull()
  })

  it('routes user gestures to the most recently focused window', () => {
    registry.createAppWindow()
    const second = registry.createAppWindow()
    // Focus the first window again, the way a user clicking between displays
    // would.
    built[0]?.hooks.onFocused()

    registry.sendToFocusedWindow('menu:command', 'new-tab')
    expect(built[0]?.sent).toHaveLength(1)
    expect(built[1]?.sent).toHaveLength(0)

    built[1]?.hooks.onFocused()
    registry.sendToFocusedWindow('menu:command', 'close-tab')
    expect(registry.focusedWindowId()).toBe(second)
    expect(built[1]?.sent).toHaveLength(1)
  })

  it('skips a window that is already closing', () => {
    const left = registry.createAppWindow()
    registry.createAppWindow()
    registry.claimSessionForWindow('agent-1', left)

    built[0]?.hooks.onClosing()
    registry.sendToSessionWindow('agent-1', 'session:screen', { sessionId: 'agent-1' })

    // Anything sent to a renderer being destroyed is at best wasted, and at
    // worst a message the sender believes reached a live workspace.
    expect(built[0]?.sent).toEqual([])
  })

  it('reports a closed window only after it is gone from the registry', () => {
    const closing = registry.createAppWindow()
    const survivor = registry.createAppWindow()
    built[1]?.hooks.onFocused()

    let survivorAtCloseTime: string | null = null
    registry.setWindowClosedObserver(() => {
      survivorAtCloseTime = registry.focusedWindowId()
    })
    built[0]?.hooks.onClosed()

    // The handoff picks its destination with `focusedWindowId()`. If the
    // observer ran before the map delete, the closing window could still be the
    // most recently focused one and would be handed its own workspace.
    expect(survivorAtCloseTime).toBe(survivor)
    expect(registry.listWindowIds()).toEqual([survivor])
    expect(registry.listWindowIds()).not.toContain(closing)
  })

  it('resumes delivery when a close is vetoed', () => {
    const window = registry.createAppWindow()
    registry.claimSessionForWindow('agent-1', window)

    // Electron emits `close` BEFORE the renderer's beforeunload veto, so a
    // window that ends up surviving has already been marked as closing. Without
    // the veto hook the flag stays latched and this window is skipped by every
    // main→renderer send for the rest of its life: panes freeze, the menu stops
    // working, and only a restart recovers.
    built[0]?.hooks.onClosing()
    registry.sendToSessionWindow('agent-1', 'session:screen', { sessionId: 'agent-1' })
    expect(built[0]?.sent).toEqual([])

    built[0]?.hooks.onCloseVetoed()
    registry.sendToSessionWindow('agent-1', 'session:screen', { sessionId: 'agent-1' })
    expect(built[0]?.sent).toHaveLength(1)
  })

  it('tells its observer when a close is vetoed', () => {
    const window = registry.createAppWindow()
    const vetoed: string[] = []
    registry.setWindowCloseVetoedObserver(id => vetoed.push(id))

    built[0]?.hooks.onClosing()
    built[0]?.hooks.onCloseVetoed()

    // The sheet is the only party that knows a ⌘Q was cancelled. A latched quit
    // flag silently disables the workspace handoff for the rest of the session.
    expect(vetoed).toEqual([window])
  })

  it('does not hand a user gesture to a window that is closing', () => {
    registry.createAppWindow()
    const live = registry.createAppWindow()
    built[1]?.hooks.onFocused()
    built[0]?.hooks.onFocused()
    built[0]?.hooks.onClosing()

    // Otherwise a menu click or dictation hotkey during another window's close
    // dialog is silently dropped instead of landing on a live window.
    expect(registry.focusedWindowId()).toBe(live)
    registry.sendToFocusedWindow('menu:command', 'new-tab')
    expect(built[1]?.sent).toHaveLength(1)
  })

  it('still resolves a save from a window that has just been destroyed', () => {
    const window = registry.createAppWindow()
    // The fake assigns webContents.id from creation order; this is the first.
    const webContentsId = 1
    built[0]?.hooks.onClosed()

    // `useAutoSave` flushes a final save from `beforeunload`, and main can
    // dequeue that message after `closed`. Rejecting it would drop the last
    // 400ms of the user's work on every window close — and the workspace
    // handoff is designed around admitting exactly that save.
    expect(registry.windowIdForWebContentsId(webContentsId)).toBe(window)
  })

  it('broadcasts app-wide state to every live window', () => {
    registry.createAppWindow()
    registry.createAppWindow()
    registry.broadcastToWindows('cli-updates:state', { claude: 'current' })
    expect(built[0]?.sent).toHaveLength(1)
    expect(built[1]?.sent).toHaveLength(1)
  })
})
