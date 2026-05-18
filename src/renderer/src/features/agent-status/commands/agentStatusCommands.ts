import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

function focusedAgentSessionId(ctx: CommandContext): string | null {
  const sessionId = commandTargetSessionId(ctx.workspace)
  if (!sessionId) return null
  const meta = ctx.workspace.state.sessions[sessionId]
  if (!meta) return null
  const kind = meta.kind ?? 'claude'
  return kind === 'claude' || kind === 'codex' ? sessionId : null
}

export const agentStatusCommands: CommandDef[] = [
  {
    id: 'show-agent-status',
    title: 'Agent Status',
    description: '**What it does:** Shows or hides a compact **Agent Status** panel for the focused Claude or Codex agent.\n\n**Use when:** You need identity, placement, runtime status, MCP domains, or orchestration/link metadata without opening raw debug panels.\n\n**Notes:** Follows the current command target, including focused Dispatch rows.',
    keywords: ['agent', 'status', 'show', 'state', 'inspect', 'runtime', 'session', 'mcp', 'orchestration', 'linked'],
    when: ctx => focusedAgentSessionId(ctx) !== null,
    getState: ({ flags }) => ({
      label: flags.agentStatusPanelOpen ? 'On' : 'Off',
      tone: flags.agentStatusPanelOpen ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => {
      ui.closePalette()
      ui.toggleAgentStatusPanel()
    },
  },
]
