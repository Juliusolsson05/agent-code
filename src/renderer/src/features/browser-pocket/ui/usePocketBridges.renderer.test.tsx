import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { GlobalToastProvider } from '@renderer/ui/GlobalToast'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { usePocketBridges } from './usePocketBridges'
import { usePocketLiveStore } from '../state/pocketLiveStore'

// Review round 3, C #2 and C #3: the bridges hook had no test of its own, and
// both findings live in IPC callbacks the host tests never reach — the
// pocketId mint racing itself, and the flags broadcast being the only line
// main ever hears. Only the Electron edge is faked (a recording window.api);
// the real hook, stores and provider run.

const subs: Record<string, (p: unknown) => void> = {}
const flagsSent: Array<{ enabled: boolean; allowEvaluate: boolean }> = []

function installApi() {
  window.api = new Proxy({
    setPocketFlags: (flags: { enabled: boolean; allowEvaluate: boolean }) => { flagsSent.push(flags) },
    setPocketPortWatch: () => {},
  } as Record<string, unknown>, {
    get: (target, key: string) => {
      if (key in target) return target[key]
      // Every onPocket* subscription: remember the callback so a test can
      // play main's role by invoking it directly.
      if (/^on[A-Z]/.test(key)) {
        return (cb: (p: unknown) => void) => {
          subs[key] = cb
          return () => { delete subs[key] }
        }
      }
      return () => {}
    },
  }) as unknown as typeof window.api
}

type WsState = Workspace['state']

/**
 * Models the two state levels the race actually lives between: zustand
 * applies `updateBrowserPocket` synchronously to the STORE, but the bridge
 * reads `workspaceRef.current.state` — the snapshot of the LAST RENDER, which
 * only advances when the host re-renders and passes a new workspace object
 * (`rerenderWith` below). Two IPC callbacks in one tick therefore both see
 * the pre-update snapshot, exactly like production.
 */
function workspace() {
  // One claude agent, as in the host tests: attachPocket only ever attaches
  // to an EXISTING session meta, never creates one.
  let committed: WsState = { sessions: { s1: { cwd: '/w', kind: 'claude', projectId: 'proj' } }, stage: { lanes: [] } } as unknown as WsState
  const ws = {
    state: committed,
    runtimes: {},
    updateBrowserPocket: vi.fn((transform: (s: WsState) => WsState) => { committed = transform(committed) }),
  } as unknown as Workspace
  return { ws, committed: () => committed, rerenderWith: () => { ws.state = committed } }
}

const renderBridges = (ws: Workspace, enabled = true) => renderHook(
  (props: { ws: Workspace; enabled: boolean }) => usePocketBridges(props.ws, props.enabled),
  { wrapper: ({ children }) => <GlobalToastProvider>{children}</GlobalToastProvider>, initialProps: { ws, enabled } },
)

let originalSettings = useAppStore.getState().settings

beforeEach(() => {
  originalSettings = useAppStore.getState().settings
  for (const key of Object.keys(subs)) delete subs[key]
  flagsSent.length = 0
  installApi()
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ settings: originalSettings })
  usePocketLiveStore.setState({ live: {} })
})

describe('browser-pocket:open-request (the pocketId mint)', () => {
  it('two concurrent browser_open calls share ONE pocketId, so no orphan live-store entry', () => {
    const { ws } = workspace()
    renderBridges(ws)
    const open = subs['onPocketOpenRequest']!
    act(() => {
      open({ sessionId: 's1', url: 'http://localhost:5173/' })
      open({ sessionId: 's1', url: 'http://localhost:5173/' })
    })
    expect(ws.updateBrowserPocket).toHaveBeenCalledTimes(2)
    // The workspace keeps only the first mint (attachPocket never re-mints an
    // existing pocket), so a second minted id would be an orphan entry in
    // pocketLiveStore that nothing ever forgets.
    expect(Object.keys(usePocketLiveStore.getState().live)).toHaveLength(1)
  })

  it('an existing pocket wins over any pending mint once the workspace re-renders', () => {
    const { ws, rerenderWith, committed } = workspace()
    renderBridges(ws)
    const open = subs['onPocketOpenRequest']!
    act(() => { open({ sessionId: 's1', url: 'http://localhost:5173/' }) })
    // React committed the attach and the host passed the new snapshot.
    act(() => { rerenderWith() })
    act(() => { open({ sessionId: 's1', url: 'http://localhost:3000/' }) })
    const ids = Object.keys(usePocketLiveStore.getState().live)
    expect(ids).toHaveLength(1)
    expect(committed().sessions['s1']?.browserPocket?.pocketId).toBe(ids[0])
  })
})

describe('browser-pocket:set-flags (cross-window desync)', () => {
  it('re-sends the flags when its window regains focus, with the CURRENT settings', () => {
    renderBridges(workspace().ws)
    expect(flagsSent).toHaveLength(1) // the mount effect
    // Focus alone must re-send (no settings change here, so the [enabled,
    // allowEvaluate] effect cannot mask a missing focus listener).
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(flagsSent).toHaveLength(2)
    // And the send carries the CURRENT values, not a stale mount closure:
    // settings changed since mount (here: in this window; in production most
    // often because the OTHER window toggled the feature and this window's
    // store is the stale one). The flags follow the focused window.
    act(() => {
      useAppStore.setState({ settings: { ...useAppStore.getState().settings, browserPocketAllowEvaluate: true } })
    })
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(flagsSent.at(-1)).toEqual({ enabled: true, allowEvaluate: true })
    expect(flagsSent).toHaveLength(4) // mount + focus + settings effect + focus
  })
})
