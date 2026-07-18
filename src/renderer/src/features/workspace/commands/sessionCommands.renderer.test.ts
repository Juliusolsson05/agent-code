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
        builtInMcpDomains: ['workflows'],
        cwd: '/projects/klay',
      },
    )
    expect(closePalette).toHaveBeenCalledOnce()
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
    expect(command.getState?.(context)).toEqual({ label: 'On', tone: 'danger' })
    command.run(context)
    expect(toggleRenderingDebugMode).toHaveBeenCalledOnce()
  })
})
