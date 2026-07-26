import { value } from '@renderer/features/command-palette/commandState'
import type { ResolvedCommand } from '@renderer/features/command-palette/types'
import type { AgentPaneLabelTarget } from '@renderer/workspace/tile-tree/paneLabels'

const AGENT_INDEX_COMMAND_PREFIX = 'agent-index:'

export function buildAgentIndexCommand(
  target: AgentPaneLabelTarget,
  focusAgentByPaneLabel: (label: string) => Promise<boolean>,
): ResolvedCommand {
  return {
    id: `${AGENT_INDEX_COMMAND_PREFIX}${target.sessionId}`,
    title: `Go to ${target.label} · ${target.title}`,
    description: [
      `**What it does:** Focuses live agent **${target.label}** in its existing view, or shows it in the currently focused view slot.`,
      '',
      `**Target:** ${target.title} · ${target.tabTitle} · ${target.cwd}`,
      '',
      '**Notes:** Reuses the running session. It does not clone, resume, restart, or kill the agent.',
    ].join('\n'),
    surface: 'app',
    keywords: [],
    keepPaletteOpen: false,
    // The provider kind is CONTEXT about the destination, not an enabled
    // state — the same correction applied to the provider badges on Reload and
    // Switch Provider.
    state: value(target.kind),
    run: async () => {
      // Resolve by the visible coordinate again inside the workspace action.
      // The palette result is only a preview; the action is the authority that
      // protects against a tab reorder/close between render and Enter.
      await focusAgentByPaneLabel(target.label)
    },
  }
}

export function isAgentIndexCommand(command: ResolvedCommand): boolean {
  return command.id.startsWith(AGENT_INDEX_COMMAND_PREFIX)
}
