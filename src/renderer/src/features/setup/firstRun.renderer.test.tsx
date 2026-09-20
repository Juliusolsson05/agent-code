import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspace } from '@renderer/workspace/hook'
import { SetupGate } from '@renderer/features/setup/ui/SetupGate'
import { setupCommands } from '@renderer/features/setup/commands/setupCommands'
import { resetSetupStoreForTests } from '@renderer/features/setup/store'
import {
  loadFirstRunCheck,
  withoutMachineWideInstalls,
} from '@shared/setup/firstRunRecordings.testSupport'
import type { SessionSpawnOptions } from '@preload/api/types'
import type { SetupCheckResult } from '@shared/types/setup'
import type { CommandContext } from '@renderer/features/command-palette/types'

// The first run, end to end in the renderer (#995 stage 6): the REAL
// workspace hook with its REAL bootstrap, the REAL SetupGate and the setup
// store they share. Main is represented by the check it RECORDED on a
// simulated clean Mac (testing/fixtures/first-run) and by a spawn that
// behaves like SessionManager's: a provider the check did not find fails
// with SessionManager's own error, and a terminal always starts.
//
// Only process and IPC ingress are suppressed, as in the other whole-hook
// suites.
vi.mock('@renderer/workspace/hook/ipc/useIpcSubscriptions', () => ({ useIpcSubscriptions: () => undefined }))
vi.mock('@renderer/workspace/hook/ipc/useWorkspaceAdoption', () => ({ useWorkspaceAdoption: () => undefined }))
vi.mock('@renderer/features/sessionFeed/SessionFeedContext', () => ({ useSessionFeed: () => ({}) }))
vi.mock('@renderer/performance/client', () => ({
  mark: vi.fn(),
  span: () => ({ end: vi.fn(), fail: vi.fn() }),
  measure: <T,>(_name: string, fn: () => T | Promise<T>) => fn(),
}))

const originalStore = useAppStore.getState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
beforeEach(() => resetSetupStoreForTests())
afterEach(() => {
  cleanup()
  resetSetupStoreForTests()
  useAppStore.setState(originalStore, true)
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

/** The machine as main sees it. `checks` are returned in order, the last one
 *  repeating, so a test can install a CLI between two Retry presses. */
function mountMachine(checks: SetupCheckResult[], options: { failKinds?: string[] } = {}) {
  let sequence = 0
  let current = checks[0]!
  const setupCheck = vi.fn(async () => {
    current = checks[Math.min(sequence, checks.length - 1)]!
    sequence += 1
    return current
  })
  const spawnSession = vi.fn(async (spawn: SessionSpawnOptions) => {
    const kind = spawn.kind ?? 'claude'
    const installed = kind === 'terminal' || current.usableProviders.includes(kind as never)
    if (!installed || options.failKinds?.includes(kind)) {
      // SessionManager's own message for a CLI it cannot resolve.
      throw new Error(`${kind} CLI not found. Open Setup (File › Setup…) to install it or enter its path.`)
    }
    return { sessionId: `session-${spawnSession.mock.calls.length}` }
  })
  Object.defineProperty(window, 'api', { configurable: true, value: {
    loadWorkspace: async () => null,
    defaultCwd: async () => '/Users/someone',
    setupCheck,
    setupSkipOptional: vi.fn(async () => current),
    spawnSession,
    onOrchestrationRequest: () => () => undefined,
    onAgentManagementRequest: () => () => undefined,
    ghostRead: async () => [],
    reportSessionLifecycle: vi.fn(),
    appendFeedDebugLog: async () => undefined,
  } })
  const hook = renderHook(() => useWorkspace())
  render(<SetupGate />)
  return { hook, spawnSession, setupCheck }
}

const spawnedKinds = (spawnSession: ReturnType<typeof mountMachine>['spawnSession']) =>
  spawnSession.mock.calls.map(([spawn]) => spawn.kind ?? 'claude')
const projects = () => useAppStore.getState().workspaceState.tabs.length

describe('first run on a Mac with no provider (#995)', () => {
  const noProvider = () => withoutMachineWideInstalls(loadFirstRunCheck('clean-machine'))

  it('explains, offers each install command, and spawns nothing until the user answers', async () => {
    const { spawnSession } = mountMachine([noProvider()])
    expect(await screen.findByText('No agent provider is installed yet')).toBeTruthy()
    expect(screen.getByText('curl -fsSL https://claude.ai/install.sh | bash')).toBeTruthy()
    expect(screen.getByText('curl -fsSL https://chatgpt.com/codex/install.sh | sh')).toBeTruthy()
    // Before #995 bootstrap spawned Claude here, underneath the gate, and
    // the failure left no project and autosave off.
    expect(spawnSession).not.toHaveBeenCalled()
    // The acknowledgment is the button; a stray Escape decides nothing while
    // the bootstrap is parked on this answer.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(spawnSession).not.toHaveBeenCalled()
    // Answer it before the test ends: the waiting bootstrap is subscribed to
    // the module-wide setup store, and left waiting it would be released by
    // the NEXT test's answer and add a second project there.
    fireEvent.click(screen.getByRole('button', { name: 'Continue with a terminal' }))
    await waitFor(() => expect(projects()).toBe(1))
  })

  it('"Continue with a terminal" opens a terminal project, and the run can save', async () => {
    const { hook, spawnSession } = mountMachine([noProvider()])
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with a terminal' }))
    await waitFor(() => expect(projects()).toBe(1))
    expect(spawnedKinds(spawnSession)).toEqual(['terminal'])
    // `fresh` is the one status that unlocks autosave on an empty disk.
    await waitFor(() => expect(hook.result.current.restoreStatus).toBe('fresh'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('installing a CLI and pressing Retry makes the first project an agent', async () => {
    // The second probe is the developer machine's: Claude now resolves.
    const { spawnSession } = mountMachine([noProvider(), loadFirstRunCheck('developer-machine')])
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(projects()).toBe(1))
    expect(spawnedKinds(spawnSession)).toEqual(['claude'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('first run on the packaged app (#995, bundled OpenCode #994)', () => {
  it('opens straight into the bundled OpenCode, with no panel in the way', async () => {
    const { spawnSession } = mountMachine([loadFirstRunCheck('clean-machine-packaged')])
    await waitFor(() => expect(projects()).toBe(1))
    expect(spawnedKinds(spawnSession)).toEqual(['opencode'])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('falls back to a terminal when the chosen provider still fails to start', async () => {
    // A probe can say "found" for a binary that then fails to spawn. The run
    // must still end with a project, or autosave stays off for all of it.
    const { spawnSession } = mountMachine([loadFirstRunCheck('clean-machine-packaged')], { failKinds: ['opencode'] })
    await waitFor(() => expect(projects()).toBe(1))
    expect(spawnedKinds(spawnSession)).toEqual(['opencode', 'terminal'])
  })
})

describe('Setup can be reopened (#995 finding 2)', () => {
  it('Open Setup shows the panel on a machine with everything installed, re-probes, and Escape closes it', async () => {
    const { setupCheck } = mountMachine([loadFirstRunCheck('developer-machine')])
    await waitFor(() => expect(projects()).toBe(1))
    expect(screen.queryByRole('dialog')).toBeNull()
    const probesBefore = setupCheck.mock.calls.length
    await act(async () => {
      setupCommands.find(command => command.id === 'open-setup')!.run({ ui: { closePalette: vi.fn() } } as unknown as CommandContext)
    })
    expect(await screen.findByText('Agent Code Setup')).toBeTruthy()
    await waitFor(() => expect(setupCheck.mock.calls.length).toBeGreaterThan(probesBefore))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('takes focus, so keystrokes cannot reach the agent pane underneath (#1047 review)', async () => {
    // The first version stamped the interaction-owner marker and said
    // aria-modal but never moved focus. The keyboard router's ownership branch
    // does not stop propagation and a terminal pane forwards keys to its PTY,
    // so typing — and Enter — reached the live shell under a panel that looked
    // modal.
    const { setupCheck } = mountMachine([loadFirstRunCheck('developer-machine')])
    await waitFor(() => expect(projects()).toBe(1))
    const outside = document.createElement('textarea')
    document.body.appendChild(outside)
    outside.focus()
    expect(setupCheck).toHaveBeenCalled()
    await act(async () => {
      setupCommands.find(command => command.id === 'open-setup')!.run({ ui: { closePalette: vi.fn() } } as unknown as CommandContext)
    })
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    expect(document.activeElement).not.toBe(outside)
    // Radix marks the rest of the document inert while the dialog is open.
    expect(outside.closest('[aria-hidden="true"]') ?? document.body.getAttribute('aria-hidden')).toBeTruthy()
    outside.remove()
  })
})

describe('the setup panel never strands the first run (#1047 review)', () => {
  it('answers the panel even when recording the skipped helper fails', async () => {
    // setup.json is best effort (a full disk, a read-only state dir). The
    // acknowledgment is not: before this, the failure left the panel up with
    // no Escape and the bootstrap waiting on a decision that could not arrive.
    const check = withoutMachineWideInstalls(loadFirstRunCheck('clean-machine'))
    const withMissingHelper: SetupCheckResult = {
      ...check,
      tools: { ...check.tools, mitmdump: { ...check.tools.mitmdump, found: false, path: null, source: undefined, installable: true, skipped: false } },
    }
    const { spawnSession } = mountMachine([withMissingHelper])
    window.api.setupSkipOptional = vi.fn(async () => { throw new Error('ENOSPC: no space left on device') })
    fireEvent.click(await screen.findByRole('button', { name: 'Continue with a terminal' }))
    await waitFor(() => expect(projects()).toBe(1))
    expect(spawnedKinds(spawnSession)).toEqual(['terminal'])
  })

  it('says Close, not "Continue with a terminal", when no bootstrap is waiting', async () => {
    // A returning user whose workspace restored, on a machine with no
    // provider: the panel still explains, but pressing the button dismisses
    // it — it does not open a terminal project.
    const check = withoutMachineWideInstalls(loadFirstRunCheck('clean-machine'))
    const { spawnSession } = mountMachine([check])
    await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: 'Continue with a terminal' }))
    await waitFor(() => expect(projects()).toBe(1))
    // Now nothing is waiting: reopen it and the button reads Close.
    await act(async () => {
      setupCommands.find(command => command.id === 'open-setup')!.run({ ui: { closePalette: vi.fn() } } as unknown as CommandContext)
    })
    await screen.findByRole('dialog')
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Continue with a terminal' })).toBeNull()
    expect(spawnedKinds(spawnSession)).toEqual(['terminal'])
  })
})
