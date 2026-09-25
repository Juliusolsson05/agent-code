import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { commandTarget } from '@renderer/features/command-palette/commandTarget'
import { dispatchCommand, __resetInFlightForTests } from '@renderer/features/command-palette/executeCommand'
import { isSessionOnScreen, targetedCommandContext } from '@renderer/features/command-palette/targetedCommandContext'
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { loadRecordedDispatchWorkspace } from '@renderer/workspace/testing/recordedDispatchWorkspace'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// #1180: the Sessions list right-click menu runs catalog commands against the
// ROW the user clicked, which is usually not the focused agent — very often
// not in any lane at all. Every command in the menu used to resolve its target
// from focus, so the failure this suite exists to catch is quiet and severe:
// "Close Agent" on row B closing the agent in the focused lane, A.
//
// WHY one table over the whole flagged set instead of a test per command:
// opting into the menu is one line of metadata (`contextMenu`), and the
// dangerous mistake is adding that line to a command whose `run` still calls
// a `*Focused*` wrapper or `commandTargetSessionId`. The first test below makes
// the table exhaustive, so a newly flagged command fails here until someone
// has stated — and checked — what it does to the target.
//
// WHY the recorded workspace (`dispatch-global-d23.json`) rather than a
// two-session literal: it is a real 24-agent, 4-project layout the app wrote,
// with Claude, Codex and a terminal, four occupied lanes, and — the case the
// menu is FOR — agents that are in no lane. The one edit is `providerSessionId`
// on the two sessions under test: the recording was scrubbed of provider ids,
// and without one Reload/Rewind/Duplicate/Copy Resume refuse on both sessions,
// which would make "the focused agent was untouched" pass vacuously.

// Focused lane 1 shows session-17 (Codex, project tab-4). session-3 (Claude)
// is in ANOTHER project (tab-1) and in no lane — the menu's hardest case: a
// command that resolves anything from focus gets the agent, the project, or
// the lane wrong, and the checks below see each.
const FOCUSED = 'session-17' as SessionId
const TARGET = 'session-3' as SessionId
// The two live in different projects in the recording, which is what makes
// the Duplicate row below able to catch a clone filed by focus.
const TARGET_PROJECT = loadRecordedDispatchWorkspace().state.sessions[TARGET]!.projectId!

type Harness = {
  ctx: CommandContext
  state: WorkspaceState
  /** Every call any fake received, as [name, args] in order. */
  calls: Array<[string, unknown[]]>
}

function recordingFake(calls: Harness['calls'], name: string, result?: unknown) {
  return vi.fn((...args: unknown[]) => {
    calls.push([name, args])
    return result
  })
}

function harness(): Harness {
  const recorded = loadRecordedDispatchWorkspace().state
  const state: WorkspaceState = {
    ...recorded,
    sessions: {
      ...recorded.sessions,
      [FOCUSED]: { ...recorded.sessions[FOCUSED]!, providerSessionId: 'provider-focused' },
      [TARGET]: { ...recorded.sessions[TARGET]!, providerSessionId: 'provider-target' },
    },
  }
  const calls: Harness['calls'] = []
  const workspace = {
    state,
    getRuntime: () => emptyRuntime(),
    closeFocused: recordingFake(calls, 'closeFocused'),
    closeSession: recordingFake(calls, 'closeSession', Promise.resolve()),
    reloadFocusedAgent: recordingFake(calls, 'reloadFocusedAgent', Promise.resolve()),
    reloadSessionAgent: recordingFake(calls, 'reloadSessionAgent', Promise.resolve({ status: 'failed', message: 'Replacement was not committed' })),
    pinSession: recordingFake(calls, 'pinSession'),
    unpinSession: recordingFake(calls, 'unpinSession'),
    splitFocused: recordingFake(calls, 'splitFocused', Promise.resolve()),
    createDetachedDispatchAgent: recordingFake(calls, 'createDetachedDispatchAgent', Promise.resolve('clone-session')),
    showPaneToast: recordingFake(calls, 'showPaneToast'),
  } as unknown as Workspace
  // Any `ui.*` a command reaches for is recorded under its own name, so the
  // table can assert on it without this harness enumerating the ui bucket.
  const ui = new Proxy({}, {
    get: (_target, key) => (typeof key === 'string' ? recordingFake(calls, `ui.${key}`) : undefined),
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      duplicateSession: recordingFake(calls, 'api.duplicateSession', Promise.resolve({ newProviderSessionId: 'clone' })),
      controlGoalLoop: recordingFake(calls, 'api.controlGoalLoop', Promise.resolve()),
    },
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: recordingFake(calls, 'clipboard.writeText', Promise.resolve()) },
  })
  return { ctx: { workspace, ui, flags: {}, target: TARGET } as unknown as CommandContext, state, calls }
}

// What each flagged command must do to TARGET. `setup` adjusts the recording
// only where a command's precondition needs it (Unpin needs a pin).
const EXPECTED: Record<string, {
  setup?: (state: WorkspaceState) => void
  effect: [string, unknown[]]
}> = {
  'agent.title.set': { effect: ['ui.openAgentTitlePrompt', [TARGET]] },
  'pin-agent': { effect: ['pinSession', [TARGET]] },
  'unpin-agent': {
    setup: state => { state.pinnedSessionIds = [FOCUSED, TARGET] },
    effect: ['unpinSession', [TARGET]],
  },
  'reload-agent': { effect: ['reloadSessionAgent', [TARGET]] },
  // (A failed targeted reload also re-reports on TARGET — see the toast test.)
  'switch-provider': { effect: ['ui.openProviderSwitchPicker', [TARGET]] },
  'agent-mcp-servers': { effect: ['ui.openAgentMcpServers', [TARGET]] },
  // The clone is filed under the TARGET's project, unplaced — never through
  // `splitFocused`, which files by the focused lane (#1180 review).
  'duplicate-agent': {
    effect: ['createDetachedDispatchAgent', [
      expect.objectContaining({ kind: 'claude' }),
      { tabId: TARGET_PROJECT, anchorSessionId: TARGET },
      expect.objectContaining({ resumeSessionId: 'clone' }),
      { selectCreated: false },
    ]],
  },
  'rewind-to-prompt': { effect: ['ui.openRewindPrompt', [TARGET]] },
  'view-prompts': { effect: ['ui.openViewPrompts', [TARGET]] },
  'view-tldr-history': { effect: ['ui.openReportHistory', [TARGET, 'tldr']] },
  'view-goal-history': { effect: ['ui.openReportHistory', [TARGET, 'goal']] },
  'goal-loop-stop': { effect: ['api.controlGoalLoop', [{ sessionId: TARGET, action: 'stop' }]] },
  'copy-resume-command': { effect: ['clipboard.writeText', [expect.stringContaining('provider-target')]] },
  // The target has never been on screen, so no transcript is loaded: the
  // command must SAY so on the target rather than silently doing nothing.
  'copy-last-assistant': { effect: ['showPaneToast', [TARGET, expect.stringContaining('No response')]] },
  'close-pane': { effect: ['closeSession', [TARGET, { killCaller: 'close.context-menu' }]] },
}

const flagged = builtInCommandCatalog.filter((command): command is CommandDef & Required<Pick<CommandDef, 'contextMenu'>> =>
  command.contextMenu !== undefined)

/** Every argument, recursively, that names one of the two sessions. */
function namedSessions(value: unknown, found = new Set<string>()): Set<string> {
  if (value === FOCUSED || value === TARGET) found.add(value)
  else if (typeof value === 'string' && (value.includes('provider-focused'))) found.add(FOCUSED)
  else if (typeof value === 'string' && value.includes('provider-target')) found.add(TARGET)
  else if (Array.isArray(value)) value.forEach(item => namedSessions(item, found))
  else if (value && typeof value === 'object') Object.values(value).forEach(item => namedSessions(item, found))
  return found
}

beforeEach(() => __resetInFlightForTests())
afterEach(() => vi.restoreAllMocks())

describe('explicit command target (#1180)', () => {
  it('has the target and the focused agent in different projects', () => {
    const { sessions } = loadRecordedDispatchWorkspace().state
    expect(sessions[TARGET]!.projectId).not.toBe(sessions[FOCUSED]!.projectId)
  })

  it('covers every command that opted into the context menu', () => {
    expect(flagged.map(command => command.id).sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  it.each(Object.keys(EXPECTED))('%s acts on the clicked agent, not the focused one', async id => {
    const { ctx, state, calls } = harness()
    EXPECTED[id]!.setup?.(state)
    // Precondition the whole table rests on: focus really is elsewhere.
    expect(commandTarget({ workspace: ctx.workspace })).toBe(FOCUSED)

    const outcome = await dispatchCommand({ id, source: 'context-menu', ctx })
    // Let fire-and-forget work (closeSession, clipboard) settle.
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(outcome).toMatchObject({ status: 'ran' })
    const [name, args] = EXPECTED[id]!.effect
    expect(calls).toContainEqual([name, args])
    for (const [, callArgs] of calls) {
      expect(namedSessions(callArgs).has(FOCUSED)).toBe(false)
    }
    // No focus-resolving wrapper may run at all, whatever its arguments:
    // `closeFocused()` takes none and would pass the check above.
    expect(calls.map(([callName]) => callName)).not.toContain('closeFocused')
    expect(calls.map(([callName]) => callName)).not.toContain('reloadFocusedAgent')
    expect(calls.map(([callName]) => callName)).not.toContain('splitFocused')
  })

  it('refuses instead of falling back to focus when the clicked agent is gone', async () => {
    const { ctx, state, calls } = harness()
    delete state.sessions[TARGET]

    for (const id of Object.keys(EXPECTED)) {
      EXPECTED[id]!.setup?.(state)
      const outcome = await dispatchCommand({ id, source: 'context-menu', ctx })
      expect(outcome, id).toMatchObject({ status: 'unavailable' })
    }
    // The failure being guarded is the silent re-address — "Close Agent" on a
    // row that just exited closing the focused agent instead.
    expect(calls).toEqual([])
  })

  it('leaves palette behaviour (no target) on the focused agent', async () => {
    const { ctx, calls } = harness()
    const paletteCtx = { ...ctx, target: undefined }

    await dispatchCommand({ id: 'close-pane', source: 'palette', ctx: paletteCtx })
    await dispatchCommand({ id: 'reload-agent', source: 'palette', ctx: paletteCtx })

    expect(calls).toContainEqual(['closeFocused', []])
    expect(calls).toContainEqual(['reloadSessionAgent', [FOCUSED]])
  })
})

describe('single-flight per agent (#1180 review)', () => {
  it('runs overlapping reloads of two different agents, and still refuses a repeat for the same one', async () => {
    const { ctx } = harness()
    // Hold every reload open so the dispatches genuinely overlap.
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const reload = vi.fn(async () => { await held; return { status: 'completed', sourceSessionId: TARGET, newSessionId: TARGET } })
    ;(ctx.workspace as unknown as { reloadSessionAgent: typeof reload }).reloadSessionAgent = reload
    const OTHER = 'session-2' as SessionId // Claude, project tab-1, in no lane
    ;(ctx.workspace.state.sessions as Record<string, unknown>)[OTHER] = {
      ...ctx.workspace.state.sessions[OTHER]!, providerSessionId: 'provider-other',
    }

    const first = dispatchCommand({ id: 'reload-agent', source: 'context-menu', ctx })
    const second = dispatchCommand({ id: 'reload-agent', source: 'context-menu', ctx: { ...ctx, target: OTHER } })
    // A second reload of the SAME agent while the first is running is the
    // double-spawn single-flight exists to refuse, and must still be refused.
    const repeat = await dispatchCommand({ id: 'reload-agent', source: 'context-menu', ctx })
    release()

    expect(repeat.status).toBe('in-flight')
    expect((await first).status).toBe('ran')
    expect((await second).status).toBe('ran')
    expect(reload.mock.calls.map(call => (call as unknown[])[0])).toEqual([TARGET, OTHER])
  })
})

describe('targeted pane toasts', () => {
  it('re-reports a targeted reload failure where the wrapper can see it', async () => {
    // reloadSessionAgent toasts internally, past the wrapper; the command
    // re-reports its result through ctx.workspace so an off-screen failure
    // is not silent (#1180 review).
    const { ctx, calls } = harness()
    await dispatchCommand({ id: 'reload-agent', source: 'context-menu', ctx })
    expect(calls).toContainEqual(['showPaneToast', [TARGET, 'Replacement was not committed']])
  })

  it('also shows a global toast while the target is off screen, and only then', () => {
    const { ctx, state } = harness()
    const showGlobalToast = vi.fn()
    let takeover: { focusedSessionId: SessionId } | null = null
    const targeted = targetedCommandContext({
      ctx,
      target: TARGET,
      getState: () => state,
      getTakeover: () => takeover as never,
      showGlobalToast,
    })

    targeted.workspace.showPaneToast(TARGET, 'Copied to clipboard')
    expect(showGlobalToast).toHaveBeenCalledWith('Copied to clipboard', undefined)
    // The pane toast is still written: bring the agent into a lane and its
    // own view shows the message as it always has.
    expect(ctx.workspace.showPaneToast).toHaveBeenCalledWith(TARGET, 'Copied to clipboard', undefined)

    // Spotlight on the target: it IS on screen now, so no duplicate toast.
    showGlobalToast.mockClear()
    takeover = { focusedSessionId: TARGET }
    targeted.workspace.showPaneToast(TARGET, 'again', 4000)
    expect(showGlobalToast).not.toHaveBeenCalled()
  })

  it('treats a lane occupant as on screen and a takeover as covering the lanes', () => {
    const { state } = harness()
    expect(isSessionOnScreen(state, FOCUSED, null)).toBe(true)
    expect(isSessionOnScreen(state, TARGET, null)).toBe(false)
    // Spotlight covers the stage: the lane agent is hidden behind it.
    expect(isSessionOnScreen(state, FOCUSED, { focusedSessionId: TARGET } as never)).toBe(false)
  })
})
