import { describe, expect, it, vi } from 'vitest'

import type { CommandContext } from '@renderer/features/command-palette/types'
import { agentTitleCommands } from '@renderer/features/workspace/commands/agentTitleCommands'
import type { WorkspaceState } from '@renderer/workspace/types'

const command = agentTitleCommands[0]
if (!command) throw new Error('Set Agent Title command is missing')

function context(state: WorkspaceState) {
  const openAgentTitlePrompt = vi.fn()
  return {
    openAgentTitlePrompt,
    value: {
      workspace: { state },
      ui: { openAgentTitlePrompt },
      flags: {},
    } as unknown as CommandContext,
  }
}

function baseState(): WorkspaceState {
  return {
    tabs: [
      { id: 'tab-a', title: 'A', root: { type: 'leaf', sessionId: 'a' }, focusedSessionId: 'a' },
      { id: 'tab-b', title: 'B', root: { type: 'leaf', sessionId: 'b' }, focusedSessionId: 'b' },
    ],
    activeTabId: 'tab-a',
    gridRelatedSelections: {},
    dispatchMode: null,
    sessions: {
      a: { cwd: '/work/a', kind: 'claude' },
      b: { cwd: '/work/b', kind: 'codex' },
    },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  }
}

describe('Set Agent Title command targeting', () => {
  it('captures the focused Grid agent', () => {
    const harness = context(baseState())

    expect(command.when?.(harness.value)).toBe(true)
    command.run(harness.value)
    expect(harness.openAgentTitlePrompt).toHaveBeenCalledWith('a')
  })

  it('captures the selected classic Dispatch agent instead of stale Grid focus', () => {
    const state = baseState()
    state.dispatchMode = { scope: 'global', focusedSessionId: 'b' }
    const harness = context(state)

    command.run(harness.value)
    expect(harness.openAgentTitlePrompt).toHaveBeenCalledWith('b')
  })

  it('captures the focused Tiled Dispatch lane instead of stale Grid focus', () => {
    const state = baseState()
    state.dispatchMode = {
      scope: 'global',
      focusedSessionId: 'a',
      tiled: {
        focusedLane: 1,
        lanes: [{ selectedSessionId: 'a' }, { selectedSessionId: 'b' }],
      },
    }
    const harness = context(state)

    command.run(harness.value)
    expect(harness.openAgentTitlePrompt).toHaveBeenCalledWith('b')
  })

  it('does not advertise agent titles for a plain terminal target', () => {
    const state = baseState()
    state.sessions.a = { cwd: '/work/a', kind: 'terminal' }
    const harness = context(state)

    expect(command.when?.(harness.value)).toBe(false)
    command.run(harness.value)
    expect(harness.openAgentTitlePrompt).not.toHaveBeenCalled()
  })
})
