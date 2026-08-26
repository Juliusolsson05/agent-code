import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'

function titleTarget(ctx: CommandContext): string | null {
  const sessionId = commandTargetSessionId(ctx.workspace)
  if (!sessionId) return null
  const meta = ctx.workspace.state.sessions[sessionId]
  return meta && isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER) ? sessionId : null
}

// `surface: 'session'` is the product contract here, not just catalog
// organization. The Dispatch-aware target resolver follows the focused Grid
// pane, classic Dispatch row, or focused Tiled Dispatch lane. Re-deriving focus
// inside the modal would make the same command edit different agents depending
// on layout; capture the one resolved id when the command runs instead.
export const agentTitleCommands: CommandDef[] = [
  {
    id: 'agent.title.set',
    category: 'session',
    surface: 'session',
    title: 'Set Agent Title…',
    description:
      '**What it does:** Sets or clears a persistent title for the focused agent. ' +
      'The title appears directly below its pane header and in Dispatch.\n\n' +
      '**Use when:** You have several agents open and want a short glance label for ' +
      'what each one is working on.',
    keywords: ['agent', 'title', 'name', 'label', 'rename', 'dispatch', 'pane'],
    when: ctx => titleTarget(ctx) !== null,
    run: ctx => {
      const sessionId = titleTarget(ctx)
      if (sessionId) ctx.ui.openAgentTitlePrompt(sessionId)
    },
  },
]
