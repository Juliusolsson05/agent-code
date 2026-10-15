import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { commandExecutionRequests } from '@renderer/features/command-palette/commandExecutionRequests'
import { resolveCommandAvailability } from '@renderer/features/command-palette/resolveInvocation'
import { makeTestCommandContext } from '@renderer/features/command-palette/testing/commandContextHarness'
import type { CommandContext } from '@renderer/features/command-palette/types'
import { useCommandExecutionRequest } from '@renderer/features/command-palette/ui/useCommandExecutionRequest'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { sidekickCommandTarget } from '@renderer/workspace/sidekickPanel'

import { SIDEKICK_EXCLUDED_COMMAND_IDS } from './sidekickTarget'

// Lane parity for the Sidekick (#1493 follow-up: "the sidekick must expose
// every feature a lane does"). Fixture: the shared command-context harness
// (one lane agent, `lane`) plus a sidekick row held by this window, which is
// exactly the shape rehydrate/adoptSidekickRow produce (sidekickId, home cwd,
// no projectId).

const original = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(original, true) })

function contextWithSidekick(options: { held?: boolean } = {}): CommandContext {
  const ctx = makeTestCommandContext({ focusedSessionId: 'lane' })
  const state = ctx.workspace.state as unknown as Record<string, unknown> & { sessions: Record<string, unknown> }
  if (options.held !== false) state.sessions.sk = { kind: 'claude', cwd: '/home/u', sidekickId: 'side', providerSessionId: 'claude-session' }
  state.sidekickPanel = { open: true, width: 420, sidekickId: 'side' }
  return ctx
}

const command = (id: string) => builtInCommandCatalog.find(entry => entry.id === id)!
const sidekickKeyboard = () => act(() => { useAppStore.setState({ keyboardRegion: 'sidekick' }) })

describe('the command target follows the keyboard into the Sidekick', () => {
  it('is the sidekick row while the Sidekick owns the keyboard, and the lane otherwise', () => {
    const ctx = contextWithSidekick()
    expect(commandTargetSessionIdForState(ctx.workspace.state, null)).toBe('lane')
    sidekickKeyboard()
    expect(commandTargetSessionIdForState(ctx.workspace.state, null)).toBe('sk')
  })

  it('beats an open lane Spotlight, which covers the lanes but not the Sidekick column', () => {
    const ctx = contextWithSidekick()
    sidekickKeyboard()
    expect(commandTargetSessionIdForState(ctx.workspace.state, { tabId: 'p', focusedSessionId: 'lane' })).toBe('sk')
  })

  it('fails closed to null — never the lane — when the Sidekick owns the keyboard but holds no row', () => {
    const ctx = contextWithSidekick({ held: false })
    sidekickKeyboard()
    expect(commandTargetSessionIdForState(ctx.workspace.state, null)).toBeNull()
  })

  it('still owns the keyboard with no sidekick at all yet (the empty panel), so ⌘W cannot reach the lane behind it', () => {
    const ctx = contextWithSidekick({ held: false })
    ;(ctx.workspace.state as unknown as { sidekickPanel: unknown }).sidekickPanel = { open: true, width: 420, sidekickId: null }
    sidekickKeyboard()
    expect(commandTargetSessionIdForState(ctx.workspace.state, null)).toBeNull()
  })

  it('does not own the keyboard under Settings or with the panel closed', () => {
    const state = { sidekickPanel: { open: true, width: 420, sidekickId: 'side' }, sessions: { sk: { sidekickId: 'side' } } }
    expect(sidekickCommandTarget(state, { keyboardRegion: 'sidekick', sidekickSpotlight: false, settingsPageOpen: true }).owns).toBe(false)
    expect(sidekickCommandTarget({ ...state, sidekickPanel: { ...state.sidekickPanel, open: false } }, { keyboardRegion: 'sidekick', sidekickSpotlight: false, settingsPageOpen: false }).owns).toBe(false)
    expect(sidekickCommandTarget(state, { keyboardRegion: 'workspace', sidekickSpotlight: true, settingsPageOpen: false })).toEqual({ owns: true, sessionId: 'sk' })
  })
})

describe('lane-only commands refuse a sidekick', () => {
  it('every excluded id is a real catalog command (a typo would silently re-admit it)', () => {
    const ids = new Set(builtInCommandCatalog.map(entry => entry.id))
    for (const id of SIDEKICK_EXCLUDED_COMMAND_IDS) expect(ids.has(id), id).toBe(true)
  })

  it('Close Tab is refused from the Sidekick even with no row held (it used to close the active project)', () => {
    const ctx = contextWithSidekick({ held: false })
    expect(resolveCommandAvailability(command('close-tab'), ctx).available).toBe(true)
    sidekickKeyboard()
    expect(resolveCommandAvailability(command('close-tab'), ctx).available).toBe(false)
  })

  it('an explicit sidekick target is refused too, while agent commands stay available on it', () => {
    const ctx = { ...contextWithSidekick(), target: 'sk' }
    expect(resolveCommandAvailability(command('pin-agent'), ctx).available).toBe(false)
    expect(resolveCommandAvailability(command('reload-agent'), ctx)).toMatchObject({ available: true })
  })
})

describe('Close Focused Session on a sidekick', () => {
  it('asks to remove the sidekick and never runs the lane close path', async () => {
    const ctx = contextWithSidekick()
    const closeFocused = vi.fn()
    ;(ctx.workspace as unknown as Record<string, unknown>).closeFocused = closeFocused
    sidekickKeyboard()
    await command('close-pane').run(ctx)
    expect(useAppStore.getState().sidekickRemoveRequest).toBe('side')
    expect(closeFocused).not.toHaveBeenCalled()
  })
})

describe('external control never addresses a sidekick', () => {
  function Host({ context }: { context: CommandContext }) {
    const request = useSyncExternalStore(commandExecutionRequests.subscribe, commandExecutionRequests.snapshot)
    useCommandExecutionRequest(request, context)
    return null
  }

  it('refuses commands.run while the keyboard is in the Sidekick', async () => {
    const ctx = contextWithSidekick()
    sidekickKeyboard()
    render(<Host context={ctx} />)
    let result!: ReturnType<typeof commandExecutionRequests.request>
    act(() => { result = commandExecutionRequests.request({ commandId: 'open-settings' }) })
    await act(async () => { await result })
    expect(await result).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('Sidekick') })
  })
})
