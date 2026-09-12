import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CommandContext } from '@renderer/features/command-palette/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { sessionCommands } from '@renderer/features/workspace/commands/sessionCommands'

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

describe('Duplicate Agent command', () => {
  it('carries durable built-in MCP domains into the cloned pane', async () => {
    const duplicateSession = vi.fn().mockResolvedValue({
      newProviderSessionId: 'provider-clone',
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { duplicateSession },
    })

    const splitFocused = vi.fn().mockResolvedValue(undefined)
    const workspace = {
      state: {
        activeTabId: 'tab-klay',
        dispatchMode: null,
        sessions: {
          source: {
            cwd: '/projects/klay',
            kind: 'codex',
            providerSessionId: 'provider-source',
            builtInMcpDomains: ['workflows'],
          },
        },
        tabs: [{
          id: 'tab-klay',
          focusedSessionId: 'source',
          root: { type: 'leaf', sessionId: 'source' },
        }],
      },
      splitFocused,
      showPaneToast: vi.fn(),
    } as unknown as Workspace
    const closePalette = vi.fn()
    const context = {
      workspace,
      ui: { closePalette },
      flags: {},
    } as unknown as CommandContext
    const command = sessionCommands.find(candidate => candidate.id === 'duplicate-agent')
    if (!command) throw new Error('Duplicate Agent command is missing')

    await command.run(context)

    expect(duplicateSession).toHaveBeenCalledWith({
      provider: 'codex',
      sourceProviderSessionId: 'provider-source',
      cwd: '/projects/klay',
    })
    // The regression was invisible at transcript-clone time: only the next app restart exposed
    // that the clone had no durable domain names from which main could mint a fresh scoped token.
    expect(splitFocused).toHaveBeenCalledWith(
      'vertical',
      'codex',
      {
        resumeSessionId: 'provider-clone',
        builtInMcpOverrides: { workflows: true },
        cwd: '/projects/klay',
      },
    )
    expect(closePalette).toHaveBeenCalledOnce()
  })

  it('never hands a clone the root-management grant', async () => {
    const duplicateSession = vi.fn().mockResolvedValue({ newProviderSessionId: 'provider-clone' })
    Object.defineProperty(window, 'api', { configurable: true, value: { duplicateSession } })
    const splitFocused = vi.fn().mockResolvedValue(undefined)
    const workspace = {
      state: {
        activeTabId: 'tab-klay',
        dispatchMode: null,
        sessions: {
          source: {
            cwd: '/projects/klay',
            kind: 'codex',
            providerSessionId: 'provider-source',
            builtInMcpDomains: ['tldr', 'root_management'],
            builtInMcpOverrides: { tldr: true, root_management: true },
          },
        },
        tabs: [{ id: 'tab-klay', focusedSessionId: 'source', root: { type: 'leaf', sessionId: 'source' } }],
      },
      splitFocused,
      showPaneToast: vi.fn(),
    } as unknown as Workspace
    const context = {
      workspace,
      ui: { closePalette: vi.fn() },
      flags: {},
    } as unknown as CommandContext
    const command = sessionCommands.find(candidate => candidate.id === 'duplicate-agent')
    if (!command) throw new Error('Duplicate Agent command is missing')

    await command.run(context)

    // The confirmation dialog names one agent, so a clone was never confirmed
    // by anyone — and the granting agent's own catalog can call this command,
    // so inheriting the grant would let one confirmation replicate itself.
    expect(splitFocused).toHaveBeenCalledWith('vertical', 'codex', expect.objectContaining({
      builtInMcpOverrides: { tldr: true },
    }))
  })

  it('keeps an OpenCode Terminal clone on the native terminal runtime', async () => {
    const duplicateSession = vi.fn().mockResolvedValue({
      newProviderSessionId: 'ses_clone',
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { duplicateSession },
    })
    const splitFocused = vi.fn().mockResolvedValue(undefined)
    const context = {
      workspace: {
        state: {
          activeTabId: 'tab-opencode',
          dispatchMode: null,
          sessions: {
            source: {
              cwd: '/projects/opencode',
              kind: 'opencode',
              providerRuntime: 'terminal',
              providerSessionId: 'ses_source',
              builtInMcpDomains: ['orchestration'],
            },
          },
          tabs: [{
            id: 'tab-opencode',
            focusedSessionId: 'source',
            root: { type: 'leaf', sessionId: 'source' },
          }],
        },
        splitFocused,
        showPaneToast: vi.fn(),
      } as unknown as Workspace,
      ui: { closePalette: vi.fn() },
      flags: {},
    } as unknown as CommandContext
    const command = sessionCommands.find(candidate => candidate.id === 'duplicate-agent')
    if (!command) throw new Error('Duplicate Agent command is missing')

    await command.run(context)

    expect(splitFocused).toHaveBeenCalledWith('vertical', 'opencode', {
      resumeSessionId: 'ses_clone',
      builtInMcpOverrides: { orchestration: true },
      providerRuntime: 'terminal',
      cwd: '/projects/opencode',
    })
  })
})

describe('Remove Cybersecurity Block command', () => {
  function contextFor(session: {
    kind?: string
    providerSessionId?: string
    providerRuntime?: string
  }): CommandContext {
    return {
      workspace: {
        state: {
          activeTabId: 'tab',
          dispatchMode: null,
          sessions: {
            agent: {
              cwd: '/project',
              kind: session.kind ?? 'codex',
              providerSessionId: session.providerSessionId,
              providerRuntime: session.providerRuntime,
            },
          },
          tabs: [{
            id: 'tab',
            focusedSessionId: 'agent',
            root: { type: 'leaf', sessionId: 'agent' },
          }],
        },
        removeFocusedCyberPolicyBlock: vi.fn().mockResolvedValue(undefined),
        showPaneToast: vi.fn(),
      } as unknown as Workspace,
      ui: { closePalette: vi.fn() },
      flags: {},
    } as unknown as CommandContext
  }

  it('is available on a transcript-backed Codex pane and re-homes that pane', async () => {
    const context = contextFor({ kind: 'codex', providerSessionId: 'native-codex' })
    const command = sessionCommands.find(candidate => candidate.id === 'remove-cybersecurity-block')
    if (!command) throw new Error('Remove Cybersecurity Block command is missing')
    expect(command.when?.(context)).toBe(true)

    await command.run(context)

    expect(context.workspace.removeFocusedCyberPolicyBlock).toHaveBeenCalledOnce()
    expect(context.ui.closePalette).toHaveBeenCalledOnce()
  })

  it('stays hidden for Claude, terminal OpenCode, and a Codex pane with no provider session', () => {
    const command = sessionCommands.find(candidate => candidate.id === 'remove-cybersecurity-block')
    if (!command) throw new Error('Remove Cybersecurity Block command is missing')
    expect(command.when?.(contextFor({ kind: 'claude', providerSessionId: 'native-claude' }))).toBe(false)
    expect(command.when?.(contextFor({
      kind: 'opencode',
      providerSessionId: 'ses_term',
      providerRuntime: 'terminal',
    }))).toBe(false)
    expect(command.when?.(contextFor({ kind: 'opencode', providerSessionId: 'ses_rendered' }))).toBe(false)
    expect(command.when?.(contextFor({ kind: 'codex' }))).toBe(false)
  })

  it('does not call the workspace action when run on a non-Codex pane', async () => {
    const context = contextFor({ kind: 'claude', providerSessionId: 'native-claude' })
    const command = sessionCommands.find(candidate => candidate.id === 'remove-cybersecurity-block')
    if (!command) throw new Error('Remove Cybersecurity Block command is missing')
    await command.run(context)
    expect(context.workspace.removeFocusedCyberPolicyBlock).not.toHaveBeenCalled()
  })

  it('keeps run() as strict as when() when Codex loses transcriptRewind', async () => {
    capabilityOverride.current = { transcriptRewind: false }
    try {
      const context = contextFor({ kind: 'codex', providerSessionId: 'native-codex' })
      const command = sessionCommands.find(candidate => candidate.id === 'remove-cybersecurity-block')
      if (!command) throw new Error('Remove Cybersecurity Block command is missing')
      expect(command.when?.(context)).toBe(false)
      await command.run(context)
      expect(context.workspace.removeFocusedCyberPolicyBlock).not.toHaveBeenCalled()
    } finally {
      capabilityOverride.current = null
    }
  })
})

describe('Switch Provider command', () => {
  it('captures the command target and opens a picker without converting immediately', async () => {
    const openProviderSwitchPicker = vi.fn()
    const closePalette = vi.fn()
    const switchSessionProvider = vi.fn()
    const context = {
      workspace: {
        state: {
          activeTabId: 'tab-1',
          dispatchMode: null,
          sessions: {
            source: { cwd: '/projects/app', kind: 'claude' },
          },
          tabs: [{
            id: 'tab-1',
            focusedSessionId: 'source',
            root: { type: 'leaf', sessionId: 'source' },
          }],
        },
        switchSessionProvider,
      } as unknown as Workspace,
      ui: { openProviderSwitchPicker, closePalette },
      flags: {},
    } as unknown as CommandContext
    const command = sessionCommands.find(candidate => candidate.id === 'switch-provider')
    if (!command) throw new Error('Switch Provider command is missing')

    await command.run(context)

    expect(closePalette).toHaveBeenCalledOnce()
    expect(openProviderSwitchPicker).toHaveBeenCalledWith('source')
    expect(switchSessionProvider).not.toHaveBeenCalled()
  })
})

describe('Rendering Debug Mode command', () => {
  it('reports its interception state and delegates the toggle to the UI shell', () => {
    const toggleRenderingDebugMode = vi.fn()
    const command = sessionCommands.find(
      candidate => candidate.id === 'toggle-rendering-debug-mode',
    )
    if (!command) throw new Error('Rendering Debug Mode command is missing')

    const context = {
      flags: { renderingDebugMode: true },
      ui: { toggleRenderingDebugMode },
    } as unknown as CommandContext

    // The red On badge is a safety signal, not decoration: while active the
    // mode captures clicks before ordinary controls. A stale palette state
    // would leave users thinking the app itself had stopped responding.
    expect(command.getState?.(context)).toEqual({
      kind: 'toggle',
      value: 'on',
      // Tone is no longer authored. This mode intercepts every feed click, so
      // the warning moved from a `danger` colour into a detail string — which
      // says more and cannot drift from the actual state.
      detail: 'Feed clicks are intercepted while this is on',
    })
    command.run(context)
    expect(toggleRenderingDebugMode).toHaveBeenCalledOnce()
  })
})

function mcpCommandContext(kind: 'claude' | 'codex' | 'opencode'): {
  context: CommandContext
  replaceSession: ReturnType<typeof vi.fn>
} {
  const replaceSession = vi.fn().mockResolvedValue('replacement')
  const workspace = {
    state: {
      activeTabId: 'tab-mcp',
      dispatchMode: null,
      sessions: {
        agent: {
          cwd: '/projects/mcp',
          kind,
          providerSessionId: 'provider-session',
          builtInMcpDomains: [],
        },
      },
      tabs: [{
        id: 'tab-mcp',
        focusedSessionId: 'agent',
        root: { type: 'leaf', sessionId: 'agent' },
      }],
    },
    replaceSession,
    showPaneToast: vi.fn(),
  } as unknown as Workspace
  return {
    context: {
      workspace,
      ui: { closePalette: vi.fn() },
      flags: {},
    } as unknown as CommandContext,
    replaceSession,
  }
}

describe('built-in MCP provider command policy', () => {
  const workflowCommand = sessionCommands.find(command => command.id === 'enable-workflow-mcp')
  const orchestrationCommand = sessionCommands.find(
    command => command.id === 'enable-orchestration-mcp',
  )
  const agentManagementCommand = sessionCommands.find(
    command => command.id === 'enable-agent-management-mcp',
  )

  it('offers Workflow MCP to Codex and OpenCode but not Claude', () => {
    if (!workflowCommand) throw new Error('Workflow MCP command is missing')

    expect(workflowCommand.when?.(mcpCommandContext('codex').context)).toBe(true)
    expect(workflowCommand.when?.(mcpCommandContext('claude').context)).toBe(false)
    expect(workflowCommand.when?.(mcpCommandContext('opencode').context)).toBe(true)
  })

  it('keeps the Workflow runtime guard inert for Claude', async () => {
    if (!workflowCommand) throw new Error('Workflow MCP command is missing')
    const { context, replaceSession } = mcpCommandContext('claude')

    await workflowCommand.run(context)

    expect(replaceSession).not.toHaveBeenCalled()
  })

  it('still toggles Workflow MCP for a Codex session', async () => {
    if (!workflowCommand) throw new Error('Workflow MCP command is missing')
    const { context, replaceSession } = mcpCommandContext('codex')

    await workflowCommand.run(context)

    expect(replaceSession).toHaveBeenCalledWith('/projects/mcp', {
      kind: 'codex',
      resumeSessionId: 'provider-session',
      builtInMcpOverrides: { workflows: true },
      // Every capability reload now pins its target: Dispatch focus can move
      // while the replacement is in flight, and an unpinned reload would apply
      // the change to whichever pane became focused.
      targetSessionId: 'agent',
    })
  })

  it('advertises general MCP toggles to OpenCode now that launch config is injected', () => {
    if (!orchestrationCommand) throw new Error('Orchestration MCP command is missing')
    expect(orchestrationCommand.when?.(mcpCommandContext('opencode').context)).toBe(true)
  })

  it('offers Agent Management to every provider launcher', () => {
    if (!agentManagementCommand) throw new Error('Agent Management MCP command is missing')
    expect(agentManagementCommand.when?.(mcpCommandContext('claude').context)).toBe(true)
    expect(agentManagementCommand.when?.(mcpCommandContext('codex').context)).toBe(true)
    expect(agentManagementCommand.when?.(mcpCommandContext('opencode').context)).toBe(true)
  })

  it('toggles Agent Management for one existing session through replacement', async () => {
    if (!agentManagementCommand) throw new Error('Agent Management MCP command is missing')
    const { context, replaceSession } = mcpCommandContext('claude')

    await agentManagementCommand.run(context)

    expect(replaceSession).toHaveBeenCalledWith('/projects/mcp', {
      kind: 'claude',
      resumeSessionId: 'provider-session',
      builtInMcpOverrides: { agent_management: true },
      // Every capability reload now pins its target: Dispatch focus can move
      // while the replacement is in flight, and an unpinned reload would apply
      // the change to whichever pane became focused.
      targetSessionId: 'agent',
    })
  })
})

// ---------------------------------------------------------------------------
// Which capability gates which command.
//
// The provider matrix test pins the DATA. It cannot catch a consumer reading
// the wrong row, and the nine-agent review found four that did: View Prompts
// read the switch edge list, Reload Agent read the verified-shell-command flag,
// and Switch Provider and Copy Resume Command still asked plain agent-hood.
//
// None of it showed up in behaviour, which is the whole problem. Claude and
// Codex have every capability and OpenCode had none, so a transposed pair
// produced identical answers for all three providers. It would have started
// lying the first time a provider declared one capability without the other —
// exactly what happened when `inAppResume` was added and OpenCode turned out to
// support it.
//
// So this drives the capabilities INDEPENDENTLY: enable one, assert exactly one
// command turns on. A transposition fails here even when it is invisible
// against the real matrix.
// ---------------------------------------------------------------------------

const capabilityOverride = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('@providers/shared/featureCapabilities', async importOriginal => {
  const actual = await importOriginal<typeof import('@providers/shared/featureCapabilities')>()
  return {
    ...actual,
    getProviderFeatures: (kind: string | undefined) =>
      capabilityOverride.current
        ? { ...actual.NO_PROVIDER_FEATURES, ...capabilityOverride.current }
        : actual.getProviderFeatures(kind),
  }
})

describe('capability gates', () => {
  afterEach(() => {
    capabilityOverride.current = null
  })

  function contextWithAgent(): CommandContext {
    return {
      workspace: {
        state: {
          activeTabId: 'tab',
          dispatchMode: null,
          sessions: {
            agent: {
              cwd: '/projects/app',
              kind: 'claude',
              providerSessionId: 'provider-abc',
            },
          },
          tabs: [{
            id: 'tab',
            focusedSessionId: 'agent',
            root: { type: 'leaf', sessionId: 'agent' },
          }],
        },
      } as unknown as Workspace,
      ui: {},
      flags: {},
    } as unknown as CommandContext
  }

  /** Every command whose availability is supposed to depend on a capability. */
  const GATED = [
    'view-prompts',
    'rewind-to-prompt',
    'reload-agent',
    'copy-resume-command',
    'duplicate-agent',
    'switch-provider',
  ] as const

  function availableUnder(features: Record<string, unknown>): string[] {
    capabilityOverride.current = features
    const ctx = contextWithAgent()
    return GATED.filter(id => {
      const command = sessionCommands.find(candidate => candidate.id === id)
      if (!command) throw new Error(`command ${id} is missing`)
      return command.when ? command.when(ctx) : true
    })
  }

  it.each([
    ['promptHistoryExtraction', true, ['view-prompts']],
    ['transcriptRewind', true, ['rewind-to-prompt']],
    ['inAppResume', true, ['reload-agent']],
    ['verifiedExternalResumeCommand', true, ['copy-resume-command']],
    ['transcriptDuplicate', true, ['duplicate-agent']],
    ['switchTargets', ['codex'], ['switch-provider']],
  ])('%s enables exactly %s', (capability, value, expected) => {
    expect(availableUnder({ [capability as string]: value })).toEqual(expected)
  })

  it('offers nothing to a provider that declares nothing', () => {
    // The OpenCode-before-`inAppResume` case, and the reason agent-hood was the
    // wrong predicate: it was true here and turned all six on.
    expect(availableUnder({})).toEqual([])
  })

  it('keeps run() as strict as when() for the destructive-ish ones', async () => {
    // `when` only controls the picker ROW. A keybinding, a native menu item or
    // a programmatic dispatch reaches `run` directly, so a `run` that re-checks
    // something weaker than its `when` is a real hole rather than a style
    // point. Duplicate Agent's did exactly that — `when` asked for a transcript
    // adapter, `run` asked for agent-hood.
    capabilityOverride.current = {}
    const duplicateSession = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { duplicateSession },
    })
    const command = sessionCommands.find(candidate => candidate.id === 'duplicate-agent')
    if (!command) throw new Error('Duplicate Agent command is missing')

    await command.run({
      ...contextWithAgent(),
      ui: { closePalette: vi.fn() },
    } as unknown as CommandContext)

    expect(duplicateSession).not.toHaveBeenCalled()
  })
})

describe('Root Agent Code Management command (#906)', () => {
  function contextFor(builtInMcpDomains: string[] | undefined) {
    const replaceSession = vi.fn().mockResolvedValue('agent-2')
    const openRootManagementPrompt = vi.fn()
    const closePalette = vi.fn()
    const workspace = {
      state: {
        activeTabId: 'tab-app',
        dispatchMode: null,
        sessions: {
          agent: {
            cwd: '/projects/app',
            kind: 'claude',
            providerSessionId: 'provider-agent',
            ...(builtInMcpDomains ? { builtInMcpDomains } : {}),
          },
        },
        tabs: [{
          id: 'tab-app',
          focusedSessionId: 'agent',
          root: { type: 'leaf', sessionId: 'agent' },
        }],
      },
      replaceSession,
      showPaneToast: vi.fn(),
    } as unknown as Workspace
    const context = {
      workspace,
      ui: { closePalette, openRootManagementPrompt },
      flags: {},
    } as unknown as CommandContext
    const command = sessionCommands.find(candidate => candidate.id === 'enable-root-agent-code-management')
    if (!command) throw new Error('Root Agent Code Management command is missing')
    return { command, context, replaceSession, openRootManagementPrompt, closePalette }
  }

  it('asks for confirmation instead of reloading when turning the capability on', async () => {
    const { command, context, replaceSession, openRootManagementPrompt, closePalette } = contextFor(['tldr'])

    expect(command.getState?.(context)).toEqual({ kind: 'toggle', value: 'off' })
    await command.run(context)

    // The regression this pins: any future "simplification" that reloads
    // straight from the command would skip the warning the feature exists for.
    expect(openRootManagementPrompt).toHaveBeenCalledWith('agent')
    expect(replaceSession).not.toHaveBeenCalled()
    expect(closePalette).toHaveBeenCalledOnce()
  })

  it('reloads without the domain, and without a prompt, when turning it off', async () => {
    const { command, context, replaceSession, openRootManagementPrompt } = contextFor(['tldr', 'root_management'])

    expect(command.getState?.(context)).toEqual({ kind: 'toggle', value: 'on' })
    await command.run(context)

    expect(openRootManagementPrompt).not.toHaveBeenCalled()
    expect(replaceSession).toHaveBeenCalledWith('/projects/app', {
      kind: 'claude',
      targetSessionId: 'agent',
      resumeSessionId: 'provider-agent',
      // An explicit off, not a return to inheritance: revoking root control
      // must survive the next reload, and the pane's unrelated TLDR capability
      // keeps its own choice instead of being rewritten by this one edit.
      builtInMcpOverrides: { tldr: true, root_management: false },
    })
  })
})
