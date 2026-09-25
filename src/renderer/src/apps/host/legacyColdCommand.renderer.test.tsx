import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/hooks'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { CommandContext } from '@renderer/features/command-palette/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import { useWorkspace } from '@renderer/workspace/hook'
import type { ExtensionListEntry, ExtensionManifest } from '@shared/types/extensions'
import { deriveExtensionCommands } from './derive'
import { clearFrameDispatch, discardPendingCommands, setFrameDispatch } from './frameRegistry'

// #1013 parity review, MAJOR: a cold command from an API v1 panel extension
// must run even when the focused lane is occupied.
//
// A v1 extension executes only inside its live frame. A cold "timer.start"
// therefore queues itself and opens the view, and the queue flushes when that
// frame mounts. Under the unified stage a plain pane open waits in the POOL
// when the focused lane is occupied, so no frame mounted: the command never
// ran, and every retry pooled another copy of the view.
//
// The manifest is the real Timer 0.3.1 manifest, its last API v1 release
// (Juliusolsson05/agent-code-timer at 74de8c4c), with a panel view. The
// command is derived and run by the real host code against the real
// workspace hook; only process/IPC ingress is suppressed, as in the
// orchestration runtime test.
vi.mock('@renderer/workspace/hook/ipc/useIpcSubscriptions', () => ({ useIpcSubscriptions: () => undefined }))
vi.mock('@renderer/workspace/hook/ipc/useWorkspaceAdoption', () => ({ useWorkspaceAdoption: () => undefined }))
vi.mock('@renderer/workspace/hook/persistence/useBootstrap', () => ({ useBootstrap: () => undefined }))
vi.mock('@renderer/features/sessionFeed/SessionFeedContext', () => ({ useSessionFeed: () => ({}) }))

const manifest = JSON.parse(readFileSync(
  resolve(__dirname, '../../../../../testing/fixtures/extensions/timer-0.3.1.agent-code.extension.json'), 'utf8',
)) as ExtensionManifest
const timer: ExtensionListEntry = {
  manifest, origin: 'github', repo: 'Juliusolsson05/agent-code-timer', ref: 'v0.3.1',
  sha256: 'a'.repeat(64), installedAt: 1, present: true,
} as ExtensionListEntry

const originalStore = useAppStore.getState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')

beforeEach(() => {
  useAppStore.setState({
    workspaceState: {
      ...originalStore.workspaceState,
      activeTabId: 'project', stage: oneLaneStage('agent'), pinnedSessionIds: [],
      tabs: [{ id: 'project', title: 'Project' }],
      sessions: { agent: { kind: 'claude', cwd: '/repo', projectId: 'project', joinedAt: 0 } },
    },
    workspaceRuntimes: { agent: emptyRuntime() },
  })
  Object.defineProperty(window, 'api', { configurable: true, value: {
    onOrchestrationRequest: () => () => undefined,
    onAgentManagementRequest: () => () => undefined,
    reportSessionLifecycle: vi.fn(),
    appendFeedDebugLog: async () => undefined,
  } })
})
afterEach(() => {
  cleanup()
  discardPendingCommands('timer')
  useAppStore.setState(originalStore, true)
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

const timerViews = () => Object.entries(useAppStore.getState().workspaceState.sessions)
  .filter(([, meta]) => meta.kind === 'extension-view' && meta.extensionViewId === 'timer.main')
  .map(([id]) => id)

it('a cold legacy command puts its view on screen, reuses it on retry, and runs once the frame is up', () => {
  const hook = renderHook(() => useWorkspace())
  const openApp = vi.fn()
  const run = () => {
    const commands = deriveExtensionCommands([timer], openApp, hook.result.current.openExtensionViewInPane)
    const start = commands.find(command => command.id === 'timer.start')!
    act(() => { void start.run?.({ ui: { closePalette: vi.fn() } } as unknown as CommandContext) })
  }

  run()
  const [view] = timerViews()
  expect(view).toBeDefined()
  const { stage } = useAppStore.getState().workspaceState
  // On screen, so its frame mounts and the queued command can flush.
  expect(stage.lanes[stage.focusedLane]?.selectedSessionId).toBe(view)
  // The agent it replaced in the lane is still there, in the pool.
  expect(useAppStore.getState().workspaceState.sessions.agent).toBeDefined()
  expect(openApp).not.toHaveBeenCalled()

  // Pressing again before the frame is ready opens no second copy.
  run()
  expect(timerViews()).toEqual([view])

  // The frame signals ready: the queued command runs in it.
  const dispatch = vi.fn()
  setFrameDispatch('timer', dispatch)
  expect(dispatch).toHaveBeenCalledWith('timer.start')
  clearFrameDispatch('timer', dispatch)
})
