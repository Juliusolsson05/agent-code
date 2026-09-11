import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { toggle } from '@renderer/features/command-palette/commandState'

// Every session kind has a status worth inspecting (#865): identity, placement,
// process state and activity apply to shells; MCP/transcript rows read "none".
function focusedSessionId(ctx: CommandContext): string | null {
  const sessionId = commandTargetSessionId(ctx.workspace)
  if (!sessionId) return null
  return ctx.workspace.state.sessions[sessionId] ? sessionId : null
}

export const agentStatusCommands: CommandDef[] = [
  {
    id: 'show-agent-status',
    category: 'workspace-tools',
    surface: 'session',
    title: 'Agent Status',
    description: '**What it does:** Shows or hides a compact **Agent Status** panel for the focused agent or terminal.\n\n**Use when:** You need identity, placement, runtime status, MCP domains, or orchestration/link metadata without opening raw debug panels.\n\n**Notes:** Follows the current command target, including focused Dispatch rows.',
    keywords: ['agent', 'status', 'show', 'state', 'inspect', 'runtime', 'session', 'mcp', 'orchestration', 'linked'],
    when: ctx => focusedSessionId(ctx) !== null,
    getState: ({ flags }) => toggle(flags.agentStatusPanelOpen),
    run: ({ ui }) => {
      ui.closePalette()
      ui.toggleAgentStatusPanel()
    },
  },
]
