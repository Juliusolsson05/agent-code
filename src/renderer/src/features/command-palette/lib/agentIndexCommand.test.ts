import { describe, expect, it, vi } from 'vitest'

import {
  buildAgentIndexCommand,
  isAgentIndexCommand,
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

describe('agent index palette command', () => {
  it('builds a transient direct result and delegates using the canonical label', async () => {
    const focusAgentByPaneLabel = vi.fn(async () => true)
    const command = buildAgentIndexCommand(target, focusAgentByPaneLabel)

    expect(command.title).toBe('Go to B5 · Fix focus routing')
    expect(command.state).toEqual({ kind: 'value', label: 'codex', truth: 'runtime' })
    expect(isAgentIndexCommand(command)).toBe(true)

    await command.run({} as never)
    expect(focusAgentByPaneLabel).toHaveBeenCalledWith('B5')
  })
})
