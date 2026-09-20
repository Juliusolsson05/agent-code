import { describe, expect, it, vi } from 'vitest'

import type { CommandContext } from '@renderer/features/command-palette/types'
import { agentTitleCommands } from '@renderer/features/workspace/commands/agentTitleCommands'
import type { WorkspaceState } from '@renderer/workspace/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'

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
      { id: 'tab-a', title: 'A' },
      { id: 'tab-b', title: 'B' },
    ],
    activeTabId: 'tab-a',
    // The user is commanding `a`: one lane showing it. (This used to be said
    // by tab-a's tree focus alone, with Dispatch off; #992.)
    stage: oneLaneStage('a'),
    sessions: {
      a: { cwd: '/work/a', kind: 'claude', projectId: 'tab-a', joinedAt: 0 },
      b: { cwd: '/work/b', kind: 'codex', projectId: 'tab-b', joinedAt: 0 },
    },
    pinnedSessionIds: [],
  }
}

describe('Set Title command targeting', () => {
  it('captures the agent in the focused lane', () => {
    const harness = context(baseState())

    expect(command.when?.(harness.value)).toBe(true)
    command.run(harness.value)
    expect(harness.openAgentTitlePrompt).toHaveBeenCalledWith('a')
  })

  it('follows the lane to another project instead of the stale active project', () => {
    // activeTabId is still tab-a; the lane shows b. The lane wins (U3).
    const state = baseState()
    state.stage = oneLaneStage('b')
    const harness = context(state)

    command.run(harness.value)
    expect(harness.openAgentTitlePrompt).toHaveBeenCalledWith('b')
  })

  it('captures the FOCUSED lane when several lanes show agents', () => {
    const state = baseState()
    state.stage = {
      focusedLane: 1,
      lanes: [{ selectedSessionId: 'a' }, { selectedSessionId: 'b' }],
    }
    const harness = context(state)

    command.run(harness.value)
    expect(harness.openAgentTitlePrompt).toHaveBeenCalledWith('b')
  })

  it('offers titles for a plain terminal target too (#865)', () => {
    const state = baseState()
    // Spread, not replaced: the row carries its own membership (#992), so a
    // bare `{ cwd, kind }` here would un-file it from its project and the lane
    // would resolve no target — failing for a reason unrelated to terminals.
    state.sessions.a = { ...state.sessions.a!, kind: 'terminal' }
    const harness = context(state)

    expect(command.when?.(harness.value)).toBe(true)
    command.run(harness.value)
    expect(harness.openAgentTitlePrompt).toHaveBeenCalledWith('a')
  })

  it('uses a session-neutral title while keeping the stable command id', () => {
    // The id keys saved visibility/keybinding settings; only the label moves.
    expect(command.id).toBe('agent.title.set')
    expect(command.title).toBe('Set Title…')
  })
})
