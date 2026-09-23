import { describe, expect, it, vi } from 'vitest'

import type { CommandContext } from '@renderer/features/command-palette/types'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { mcpCommands } from './mcpCommands'

function context(kind: string) {
  const ui = { closePalette: vi.fn(), openAgentMcpServers: vi.fn(), openSettings: vi.fn(), openMcpServerDialog: vi.fn() }
  const workspace = {
    state: {
      activeTabId: 'tab',
      stage: oneLaneStage('pane'),
      pinnedSessionIds: [],
      tabs: [{ id: 'tab' }],
      sessions: { pane: { cwd: '/p', kind, projectId: 'tab', joinedAt: 0 } },
    },
  } as unknown as Workspace
  return { ctx: { workspace, ui, flags: {} } as unknown as CommandContext, ui }
}

const byId = (id: string) => {
  const command = mcpCommands.find(candidate => candidate.id === id)
  if (!command) throw new Error(`missing ${id}`)
  return command
}

describe('MCP commands (#1143)', () => {
  it('offers the per-agent picker for agents but not terminals', () => {
    const command = byId('agent-mcp-servers')
    expect(command.when?.(context('claude').ctx)).toBe(true)
    expect(command.when?.(context('codex').ctx)).toBe(true)
    expect(command.when?.(context('opencode').ctx)).toBe(true)
    expect(command.when?.(context('terminal').ctx)).toBe(false)
  })

  it('captures the target agent when the command runs, not when Apply is pressed', () => {
    const { ctx, ui } = context('codex')
    void byId('agent-mcp-servers').run(ctx)
    expect(ui.closePalette).toHaveBeenCalledOnce()
    expect(ui.openAgentMcpServers).toHaveBeenCalledWith('pane')
  })

  it('refuses to open the picker for a terminal even when invoked outside the palette', () => {
    const { ctx, ui } = context('terminal')
    void byId('agent-mcp-servers').run(ctx)
    expect(ui.openAgentMcpServers).not.toHaveBeenCalled()
  })

  it('deep-links MCP Servers to the MCP settings category', () => {
    const { ctx, ui } = context('claude')
    void byId('mcp-servers').run(ctx)
    expect(ui.openSettings).toHaveBeenCalledWith('mcp')
  })
})
