import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import type { Workspace } from '@renderer/workspace/hook'
import { navigationControlCapabilities } from './navigation'
const original = useAppStore.getState()
afterEach(() => { useAppStore.setState(original, true); vi.unstubAllGlobals() })
it('refuses acknowledgment when effective focus moves during workspace navigation', async () => {
  useAppStore.setState({ workspaceReaderMode: null, workspaceSpotlight: null, workspaceTileTabs: null,
    workspaceState: { ...original.workspaceState, activeTabId: 'project', dispatchMode: null,
      tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'target' }, focusedSessionId: 'target' }, { id: 'other-project', title: 'Other', root: { type: 'leaf', sessionId: 'other' }, focusedSessionId: 'other' }],
      sessions: { target: { kind: 'claude', cwd: '/trial' }, other: { kind: 'claude', cwd: '/trial' } }, buried: [], detachedSessions: {},
    } })
  // The review's production-handler probe changed focus at the animation-frame
  // boundary. Preserve that exact interleaving rather than mocking observation.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    useAppStore.getState().setWorkspaceState(state => ({ ...state, activeTabId: 'other-project' }))
    callback(0); return 1
  })
  const caps = navigationControlCapabilities(() => ({ restoreStatus: 'fresh', setReaderModeTarget: () => true, setSpotlightTarget: () => true, focusAgentBySessionId: async () => true }) as unknown as Workspace)
  const result = await caps.find(cap => cap.descriptor.id === 'views.agentSet')!.execute({ sessionId: 'target', mode: 'workspace' }, { requestId: 'navigation', caller: { kind: 'external', id: 'operator' }, owner: { kind: 'window', windowId: 'one', generation: 'current' } })
  expect(useAppStore.getState().workspaceState.activeTabId).toBe('other-project')
  expect(result).toMatchObject({ ok: false, error: { outcome: 'unknown' } })
})
