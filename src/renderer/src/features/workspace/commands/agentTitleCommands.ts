import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// WHY every session kind qualifies (#865): the title is session metadata, not a
// transcript feature. Plain shells were refused here (#660) until the product
// decided a terminal running a dev server deserves a glance label as much as an
// agent does. The reducer and the operator capability accept terminals too.
function titleTarget(ctx: CommandContext): string | null {
  const sessionId = commandTargetSessionId(ctx.workspace)
  if (!sessionId) return null
  return ctx.workspace.state.sessions[sessionId] ? sessionId : null
}

// `surface: 'session'` is the product contract here, not just catalog
// organization. The Dispatch-aware target resolver follows the focused Grid
// pane, classic Dispatch row, or focused Tiled Dispatch lane. Re-deriving focus
// inside the modal would make the same command edit different sessions
// depending on layout; capture the one resolved id when the command runs.
//
// WHY the id still says `agent`: command ids key saved visibility and keybinding
// settings, so renaming it would silently drop user customizations. Only the
// label became session-neutral.
export const agentTitleCommands: CommandDef[] = [
  {
    id: 'agent.title.set',
    category: 'session',
    surface: 'session',
    title: 'Set Title…',
    description:
      '**What it does:** Sets or clears a persistent title for the focused agent or terminal. ' +
      'The title appears directly below its pane header and in Dispatch.\n\n' +
      '**Use when:** You have several agents and terminals open and want a short glance label for ' +
      'what each one is doing.',
    keywords: ['agent', 'terminal', 'shell', 'title', 'name', 'label', 'rename', 'dispatch', 'pane'],
    when: ctx => titleTarget(ctx) !== null,
    run: ctx => {
      const sessionId = titleTarget(ctx)
      if (sessionId) ctx.ui.openAgentTitlePrompt(sessionId)
    },
  },
]
