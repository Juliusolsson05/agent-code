import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/hooks'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { paneCommands } from '@renderer/features/workspace/commands/paneCommands'
import type { CommandContext } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import { useWorkspace } from '../index'

// #1013 parity review, MAJOR: picking another agent INSIDE Spotlight must move
// the command target with it.
//
// On main the Spotlight pick was mirrored into the tree/Dispatch focus that
// command targeting read. The unified stage deliberately does not write the
// pick into a lane (browsing inside Spotlight is not naming a lane occupant),
// and targeting read only the focused lane, so every command run from inside
// Spotlight after a switch acted on the lane agent hidden behind it.
//
// This drives the real workspace hook and the real registered Tail command.
// Only the process/IPC ingress is suppressed, as in the orchestration runtime
// test, because this is about targeting, not spawning.
vi.mock('../ipc/useIpcSubscriptions', () => ({ useIpcSubscriptions: () => undefined }))
vi.mock('../ipc/useWorkspaceAdoption', () => ({ useWorkspaceAdoption: () => undefined }))
vi.mock('../persistence/useBootstrap', () => ({ useBootstrap: () => undefined }))
vi.mock('@renderer/features/sessionFeed/SessionFeedContext', () => ({ useSessionFeed: () => ({}) }))

const originalStore = useAppStore.getState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

beforeEach(() => {
  useAppStore.setState({
    workspaceState: {
      ...originalStore.workspaceState,
      activeTabId: 'project', stage: oneLaneStage('lane-agent'), pinnedSessionIds: [],
      tabs: [{ id: 'project', title: 'Project' }],
      sessions: {
        'lane-agent': { kind: 'claude', cwd: '/repo', projectId: 'project', joinedAt: 0 },
        'pooled-agent': { kind: 'claude', cwd: '/repo', projectId: 'project', joinedAt: 1 },
      },
    },
    workspaceRuntimes: { 'lane-agent': emptyRuntime(), 'pooled-agent': emptyRuntime() },
    workspaceSpotlight: null,
    workspaceReaderMode: null,
  })
  Object.defineProperty(window, 'api', { configurable: true, value: {
    onOrchestrationRequest: () => () => undefined,
    onAgentManagementRequest: () => () => undefined,
    ghostRead: async () => [],
    reportSessionLifecycle: vi.fn(),
    appendFeedDebugLog: async () => undefined,
  } })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(originalStore, true)
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

const runCommand = (id: string, workspace: ReturnType<typeof useWorkspace>) => {
  const command = paneCommands.find(entry => entry.id === id)
  if (!command?.run) throw new Error(`command ${id} is not registered`)
  // Tail reads only the workspace from its context.
  return command.run({ workspace } as unknown as CommandContext)
}

it('commands run from Spotlight act on the agent picked in Spotlight, not the hidden lane agent', () => {
  const hook = renderHook(() => useWorkspace())
  act(() => { hook.result.current.toggleSpotlight() })
  expect(useAppStore.getState().workspaceSpotlight?.focusedSessionId).toBe('lane-agent')

  act(() => { hook.result.current.setSpotlightSession('pooled-agent') })
  // The pick stays inside Spotlight: the lane still holds the agent it held.
  expect(useAppStore.getState().workspaceState.stage.lanes[0]?.selectedSessionId).toBe('lane-agent')
  expect(commandTargetSessionId(hook.result.current)).toBe('pooled-agent')

  act(() => { void runCommand('toggle-tail', hook.result.current) })
  const runtimes = useAppStore.getState().workspaceRuntimes
  expect(runtimes['pooled-agent']?.tailMode).toBe(true)
  expect(runtimes['lane-agent']?.tailMode).toBeFalsy()

  // Leaving Spotlight returns to the stage as it was, and so does the target.
  act(() => { hook.result.current.toggleSpotlight() })
  expect(commandTargetSessionId(hook.result.current)).toBe('lane-agent')
})
