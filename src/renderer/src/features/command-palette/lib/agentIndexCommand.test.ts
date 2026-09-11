import { describe, expect, it, vi } from 'vitest'

import {
  buildAgentIndexCommand,
  isAgentIndexCommand,
  parseAgentIndexPaletteQuery,
} from '@renderer/features/command-palette/lib/agentIndexCommand'
import type { AgentPaneLabelTarget } from '@renderer/workspace/tile-tree/paneLabels'

const target: AgentPaneLabelTarget = {
  label: 'B5',
  sessionId: 'session-b5',
  tabId: 'tab-b',
  tabTitle: 'renderer',
  title: 'Fix focus routing',
  cwd: '/work/renderer',
  kind: 'codex',
}

const terminalTarget: AgentPaneLabelTarget = {
  label: 'A1',
  sessionId: 'session-a1',
  tabId: 'tab-a',
  tabTitle: 'renderer',
  title: 'renderer',
  cwd: '/work/renderer',
  kind: 'terminal',
}

describe('agent index palette command', () => {
  it.each([
    ['A2', { label: 'A2', intent: 'reuse-existing-view' }],
    [' a2! ', { label: 'A2', intent: 'open-in-focused-tiled-dispatch-lane' }],
    ['AA30!', { label: 'AA30', intent: 'open-in-focused-tiled-dispatch-lane' }],
  ])('parses the exact coordinate query %j', (query, expected) => {
    expect(parseAgentIndexPaletteQuery(query)).toEqual(expected)
  })

  it.each(['A', '2!', 'A0!', 'A2!!', 'A2 !', 'go A2!', '★1!'])(
    'leaves malformed or non-coordinate query %j to ordinary palette search',
    query => {
      expect(parseAgentIndexPaletteQuery(query)).toBeNull()
    },
  )

  it('builds a transient direct result and delegates using the canonical label', async () => {
    const focusAgentByPaneLabel = vi.fn(async () => true)
    const command = buildAgentIndexCommand(target, focusAgentByPaneLabel)

    expect(command.title).toBe('Go to B5 · Fix focus routing')
    expect(command.description).toContain('Type `B5!`')
    expect(command.state).toEqual({ kind: 'value', label: 'codex' })
    expect(isAgentIndexCommand(command)).toBe(true)

    await command.run({} as never)
    expect(focusAgentByPaneLabel).toHaveBeenCalledWith('B5', 'reuse-existing-view')
  })

  it('describes and delegates the focused-lane override without implying a new agent', async () => {
    const focusAgentByPaneLabel = vi.fn(async () => true)
    const command = buildAgentIndexCommand(
      target,
      focusAgentByPaneLabel,
      'open-in-focused-tiled-dispatch-lane',
    )

    expect(command.title).toBe('Open B5 Here · Fix focus routing')
    expect(command.description).toContain('currently focused Tiled Dispatch lane')
    expect(command.description).toContain('Mirrors the same running session')

    await command.run({} as never)
    expect(focusAgentByPaneLabel).toHaveBeenCalledWith(
      'B5',
      'open-in-focused-tiled-dispatch-lane',
    )
  })

  it('names a terminal target as a terminal, never as an agent (#865)', () => {
    const focusAgentByPaneLabel = vi.fn(async () => true)
    const command = buildAgentIndexCommand(terminalTarget, focusAgentByPaneLabel)

    expect(command.description).toContain('live terminal **A1**')
    expect(command.description).not.toContain('agent')
    // Resume/clone are provider-process semantics; a terminal has no provider
    // process to resume, so the lifecycle note must not claim otherwise.
    expect(command.description).toContain('It does not clone, restart, or kill the terminal.')
    expect(command.description).not.toContain('resume')
  })
})
