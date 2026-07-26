import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The gateway records history through this module. Mocked rather than exercised
// for real because the real implementation writes to `window.localStorage`,
// which does not exist in the node project — it would silently swallow every
// call in its own try/catch and the history-policy assertions below (the whole
// point of the exercise) would pass vacuously.
vi.mock('@renderer/features/command-palette/lib/recentCommandHistory', () => ({
  recordCommandUse: vi.fn(),
  loadRecentHistory: vi.fn(() => []),
  buildHistoryScoreMap: vi.fn(() => new Map()),
}))

import {
  __resetInFlightForTests,
  canDispatchCommand,
  dispatchCommand,
  dispatchResolvedRow,
} from '@renderer/features/command-palette/executeCommand'
import { buildCommandRegistry } from '@renderer/features/command-palette/registry'
import { recordCommandUse } from '@renderer/features/command-palette/lib/recentCommandHistory'
import type { CommandContext } from '@renderer/features/command-palette/types'

// ---------------------------------------------------------------------------
// Phase 1: the command execution gateway.
//
// The assertions here are the executable form of the plan's central claim —
// that applicability, admission, discoverability, and authorization are four
// different questions that were collapsed into one boolean filter. The most
// important test in this file is "a command hidden from the picker still runs
// from the native menu", because that inversion (a cosmetic preference
// removing a capability) is the highest-severity defect in the audit.
// ---------------------------------------------------------------------------

/** Which ui callback a command reached for. */
let uiCalls: string[] = []

/**
 * Narrow test harness for `CommandContext`.
 *
 * WHY the ui bag is a Proxy rather than ~50 explicit stubs: none of those
 * callbacks' identities affect admission or dispatch policy, which is what
 * this file tests. What DOES matter is whether a command's `run` was reached
 * at all, so the proxy records the name and no-ops. Writing them out would add
 * fifty lines of noise that must be maintained every time a command is added,
 * and would still assert nothing extra.
 *
 * `flags`, by contrast, are written out explicitly: individual flags are real
 * inputs to the admission decision, so a default that drifts silently would
 * change what these tests mean.
 */
function makeContext(overrides?: {
  flags?: Partial<CommandContext['flags']>
  workspace?: Partial<CommandContext['workspace']>
}): CommandContext {
  const ui = new Proxy({} as CommandContext['ui'], {
    get: (_target, prop: string) => (..._args: unknown[]) => {
      uiCalls.push(prop)
    },
  })

  const workspace = {
    // An empty workspace: no tabs, no dispatch mode, no sessions. This makes
    // `commandTargetSessionId` return null, which short-circuits the
    // rendered-view gate — deliberate, so these tests isolate the surface/when
    // half of admission rather than re-testing render policy.
    state: {
      tabs: [],
      activeTabId: null,
      sessions: {},
      dispatchMode: null,
      detachedSessions: {},
      buried: [],
      pinnedSessionIds: [],
    },
    getRuntime: () => undefined,
    runtimes: {},
    activeTab: undefined,
    ...overrides?.workspace,
  } as unknown as CommandContext['workspace']

  return {
    workspace,
    ui,
    flags: {
      statusModeEnabled: true,
      worktreeBadgesEnabled: true,
      usageHeaderEnabled: true,
      usageHeaderLevel: 'all',
      dangerousAgentsEnabled: false,
      aggressiveDebugPersistenceEnabled: false,
      gitBarOpen: false,
      worktreesBarOpen: false,
      debugPanelOpen: false,
      feedDebugPanelOpen: false,
      proxyDebugPanelOpen: false,
      htmlDebugPanelOpen: false,
      renderingDebugMode: false,
      tailAllMode: false,
      devDebugEnabled: false,
      sessionRecordingEnabled: false,
      devDebugPanelOpen: false,
      agentStatusPanelOpen: false,
      performancePanelOpen: false,
      caffeinateActive: false,
      caffeinateSupported: true,
      globalEditorOpen: false,
      focusedCwd: null,
      fileTreeVisible: false,
      editorFullscreen: false,
      dispatchModeEnabled: false,
      globalDispatchEnabled: false,
      agentViewMode: 'agent',
      commandVisibilityOverrides: {},
      showHiddenCommands: false,
      ...overrides?.flags,
    },
  } as CommandContext
}

beforeEach(() => {
  uiCalls = []
  vi.mocked(recordCommandUse).mockClear()
})

afterEach(() => {
  // Single-flight state is module-scoped, so a test that leaves an id parked
  // would poison every later test in unpredictable file order. The testing
  // standard is explicit that cleanup must run after failure too, hence
  // afterEach rather than a tail call inside each test.
  __resetInFlightForTests()
})

describe('visibility is not authorization', () => {
  // THE headline defect. `new-tab` is used because it has no `when` guard, so
  // the only thing that could stop it is the visibility override — isolating
  // exactly the behavior under test.

  it('excludes a hidden command from the picker registry', () => {
    const ctx = makeContext({ flags: { commandVisibilityOverrides: { 'new-tab': false } } })
    expect(buildCommandRegistry(ctx).map(c => c.id)).not.toContain('new-tab')
  })

  it('still runs that hidden command from the native menu', async () => {
    // Before the gateway this returned undefined from `commands.find(...)` and
    // the File → New Tab menu item did nothing, silently. A user who tidied
    // their palette lost a capability with no way to connect cause to effect.
    const ctx = makeContext({ flags: { commandVisibilityOverrides: { 'new-tab': false } } })
    const outcome = await dispatchCommand({ id: 'new-tab', source: 'native-menu', ctx })

    expect(outcome.status).toBe('ran')
    expect(uiCalls).toContain('openNewTabPicker')
  })

  it('still runs that hidden command from a keybinding', async () => {
    const ctx = makeContext({ flags: { commandVisibilityOverrides: { 'new-tab': false } } })
    const outcome = await dispatchCommand({ id: 'new-tab', source: 'keybinding', ctx })
    expect(outcome.status).toBe('ran')
  })

  it('reports a hidden command as dispatchable', () => {
    const ctx = makeContext({ flags: { commandVisibilityOverrides: { 'new-tab': false } } })
    expect(canDispatchCommand('new-tab', ctx)).toBe(true)
  })
})

describe('admission cannot be bypassed by source', () => {
  // The opposite failure: before the gateway, keybindings called workspace
  // actions directly and never evaluated surface/when at all.

  it('refuses a command whose `when` guard is false, from every source', async () => {
    // `reorder-tabs` requires more than one tab; the fixture workspace has none.
    const ctx = makeContext()
    for (const source of ['palette', 'native-menu', 'keybinding', 'programmatic'] as const) {
      const outcome = await dispatchCommand({ id: 'reorder-tabs', source, ctx })
      expect(outcome.status).toBe('unavailable')
    }
    expect(uiCalls).toEqual([])
  })

  it('refuses a grid command while Dispatch Mode owns the layout', async () => {
    // The #228 class: `split-vertical` is surface 'grid' and is a silent no-op
    // in Dispatch. Silent no-ops are what the explicit outcome replaces.
    const ctx = makeContext({ flags: { dispatchModeEnabled: true } })
    const outcome = await dispatchCommand({ id: 'split-vertical', source: 'keybinding', ctx })
    expect(outcome.status).toBe('unavailable')
  })

  it('admits that same grid command outside Dispatch Mode', async () => {
    const ctx = makeContext({ flags: { dispatchModeEnabled: false } })
    expect(canDispatchCommand('split-vertical', ctx)).toBe(true)
  })

  it('distinguishes an unknown id from an unavailable one', async () => {
    // A menu or caller bug and a contextual refusal are different problems and
    // must be diagnosable apart — the plan calls this out for the native menu
    // specifically.
    const ctx = makeContext()
    const outcome = await dispatchCommand({ id: 'no-such-command', source: 'native-menu', ctx })
    expect(outcome).toEqual({
      status: 'unknown',
      id: 'no-such-command',
      source: 'native-menu',
    })
  })
})

describe('failure handling', () => {
  const boom = new Error('boom')

  it('captures a synchronous throw instead of propagating it', async () => {
    const reportError = vi.fn()
    const outcome = await dispatchResolvedRow({
      row: { id: 'x.sync', title: 'Sync', run: () => { throw boom } },
      source: 'palette',
      ctx: makeContext(),
      reportError,
    })

    expect(outcome).toMatchObject({ status: 'failed', id: 'x.sync', error: boom })
    expect(reportError).toHaveBeenCalledWith('Command failed: Sync', boom)
  })

  it('captures an async rejection instead of leaving it unhandled', async () => {
    // Every old call site was `void command.run(ctx)`. A rejected promise there
    // produced an unhandled rejection and no user-facing signal whatsoever.
    const reportError = vi.fn()
    const outcome = await dispatchResolvedRow({
      row: { id: 'x.async', title: 'Async', run: () => Promise.reject(boom) },
      source: 'palette',
      ctx: makeContext(),
      reportError,
    })

    expect(outcome).toMatchObject({ status: 'failed', error: boom })
    expect(reportError).toHaveBeenCalledOnce()
  })

  it('still resolves when no error reporter is supplied', async () => {
    // The gateway must never reject: a caller that forgets to await must not be
    // able to create an unhandled rejection.
    await expect(
      dispatchResolvedRow({
        row: { id: 'x.noreport', title: 'NoReport', run: () => Promise.reject(boom) },
        source: 'programmatic',
        ctx: makeContext(),
      }),
    ).resolves.toMatchObject({ status: 'failed' })
  })
})

describe('single-flight', () => {
  it('drops a duplicate invocation while the first is still running', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const row = { id: 'x.slow', title: 'Slow', run: () => gate }
    const ctx = makeContext()

    const first = dispatchResolvedRow({ row, source: 'palette', ctx })
    const second = await dispatchResolvedRow({ row, source: 'palette', ctx })

    // The second invocation is rejected while the first is in flight — this is
    // what stops a double-tap from spawning two agents or killing twice.
    expect(second.status).toBe('in-flight')

    release()
    expect((await first).status).toBe('ran')
  })

  it('allows the same command again once the first completes', async () => {
    const row = { id: 'x.fast', title: 'Fast', run: () => {} }
    const ctx = makeContext()
    expect((await dispatchResolvedRow({ row, source: 'palette', ctx })).status).toBe('ran')
    expect((await dispatchResolvedRow({ row, source: 'palette', ctx })).status).toBe('ran')
  })

  it('clears its in-flight entry even when the command fails', async () => {
    // A failure that left the id parked would make the command permanently
    // undispatchable until reload — a worse bug than the one single-flight
    // fixes, so the `finally` that prevents it is asserted directly.
    const row = { id: 'x.throws', title: 'Throws', run: () => { throw new Error('x') } }
    const ctx = makeContext()
    expect((await dispatchResolvedRow({ row, source: 'palette', ctx })).status).toBe('failed')
    expect((await dispatchResolvedRow({ row, source: 'palette', ctx })).status).toBe('failed')
  })
})

describe('history policy', () => {
  it('records a successful user invocation with its source', async () => {
    const ctx = makeContext()
    await dispatchCommand({ id: 'new-tab', source: 'native-menu', ctx })
    expect(recordCommandUse).toHaveBeenCalledWith('new-tab', 'native-menu')
  })

  it.each(['palette', 'native-menu', 'keybinding'] as const)(
    'records %s invocations',
    async source => {
      await dispatchCommand({ id: 'new-tab', source, ctx: makeContext() })
      expect(recordCommandUse).toHaveBeenCalledWith('new-tab', source)
    },
  )

  it('never records programmatic invocations', async () => {
    // Background machinery must not be able to reshape the user's palette
    // ranking toward commands they never chose.
    await dispatchCommand({ id: 'new-tab', source: 'programmatic', ctx: makeContext() })
    expect(recordCommandUse).not.toHaveBeenCalled()
  })

  it('does not record an unavailable command', async () => {
    await dispatchCommand({ id: 'reorder-tabs', source: 'palette', ctx: makeContext() })
    expect(recordCommandUse).not.toHaveBeenCalled()
  })

  it('does not record an unknown command', async () => {
    await dispatchCommand({ id: 'nope', source: 'palette', ctx: makeContext() })
    expect(recordCommandUse).not.toHaveBeenCalled()
  })

  it('does not record a failed command', async () => {
    // Recording before `run` — the old behavior — meant a command that threw
    // still climbed the ranking. Failing at something is not using it.
    await dispatchResolvedRow({
      row: { id: 'x.fail', title: 'Fail', run: () => { throw new Error('e') } },
      source: 'palette',
      ctx: makeContext(),
    })
    expect(recordCommandUse).not.toHaveBeenCalled()
  })

  it('does not record a dropped duplicate invocation', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const row = { id: 'x.dup', title: 'Dup', run: () => gate }
    const ctx = makeContext()

    const first = dispatchResolvedRow({ row, source: 'palette', ctx })
    await dispatchResolvedRow({ row, source: 'palette', ctx })
    release()
    await first

    // Exactly one recorded use for two invocations, because only one ran.
    expect(recordCommandUse).toHaveBeenCalledOnce()
  })

  it('does not record transient agent-index destinations', async () => {
    // Their ids embed a session id that can never rank a future palette open,
    // so recording them would evict real commands from a bounded history.
    await dispatchResolvedRow({
      row: { id: 'agent-index:abc123', title: 'Go to A', run: () => {} },
      source: 'palette',
      ctx: makeContext(),
    })
    expect(recordCommandUse).not.toHaveBeenCalled()
  })
})

describe('dispatchResolvedRow admission', () => {
  it('re-checks admission when the row is a catalog command', async () => {
    // The palette's memoized list can be a frame behind the workspace, so the
    // row the user pressed Enter on is not proof the command still applies.
    const ctx = makeContext()
    const outcome = await dispatchResolvedRow({
      row: { id: 'reorder-tabs', title: 'Reorder Tabs', run: () => { uiCalls.push('ran') } },
      source: 'palette',
      ctx,
    })
    expect(outcome.status).toBe('unavailable')
    expect(uiCalls).not.toContain('ran')
  })

  it('runs a row that has no catalog definition', async () => {
    // Transient destinations have no CommandDef to admit against; skipping
    // admission for them must not skip the other guarantees.
    const outcome = await dispatchResolvedRow({
      row: { id: 'agent-index:xyz', title: 'Go to B', run: () => { uiCalls.push('ran') } },
      source: 'palette',
      ctx: makeContext(),
    })
    expect(outcome.status).toBe('ran')
    expect(uiCalls).toContain('ran')
  })
})
