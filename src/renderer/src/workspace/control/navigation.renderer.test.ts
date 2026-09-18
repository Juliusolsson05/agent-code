import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import type { Workspace } from '@renderer/workspace/hook'
import { navigationControlCapabilities } from './navigation'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
const original = useAppStore.getState()
afterEach(() => { useAppStore.setState(original, true); vi.unstubAllGlobals() })
it('refuses acknowledgment when effective focus moves during workspace navigation', async () => {
  useAppStore.setState({ workspaceReaderMode: null, workspaceSpotlight: null,
    workspaceState: { ...original.workspaceState, activeTabId: 'project', stage: oneLaneStage('target'),
      tabs: [{ id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'target' }, focusedSessionId: 'target' }, { id: 'other-project', title: 'Other', root: { type: 'leaf', sessionId: 'other' }, focusedSessionId: 'other' }],
      sessions: { target: { kind: 'claude', cwd: '/trial' }, other: { kind: 'claude', cwd: '/trial' } }, buried: [], detachedSessions: {},
    } })
  // The review's production-handler probe changed focus at the animation-frame
  // boundary. Preserve that exact interleaving rather than mocking observation.
  //
  // HOW focus moves changed with #992. The probe used to flip `activeTabId`,
  // because effective focus was the active tab's tree focus. The active
  // project is only a label now (U4) and moving it moves nothing; the one
  // focus truth is the focused lane's occupant (U3), so the interleaved write
  // re-aims the lane — what a user clicking another agent mid-navigation does.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    useAppStore.getState().setWorkspaceState(state => ({ ...state, stage: oneLaneStage('other') }))
    callback(0); return 1
  })
  const caps = navigationControlCapabilities(() => ({ restoreStatus: 'fresh', setReaderModeTarget: () => true, setSpotlightTarget: () => true, focusAgentBySessionId: async () => true }) as unknown as Workspace)
  const result = await caps.find(cap => cap.descriptor.id === 'views.agentSet')!.execute({ sessionId: 'target', mode: 'workspace' }, { requestId: 'navigation', caller: { kind: 'external', id: 'operator' }, owner: { kind: 'window', windowId: 'one', generation: 'current' } })
  expect(useAppStore.getState().workspaceState.stage.lanes[0]?.selectedSessionId).toBe('other')
  expect(result).toMatchObject({ ok: false, error: { outcome: 'unknown' } })
})
