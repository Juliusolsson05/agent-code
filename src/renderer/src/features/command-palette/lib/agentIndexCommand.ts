import { value } from '@renderer/features/command-palette/commandState'
import type { ResolvedCommand } from '@renderer/features/command-palette/types'
import type { AgentPaneLabelTarget } from '@renderer/workspace/tile-tree/paneLabels'
import type { AgentIndexNavigationIntent } from '@renderer/workspace/agentIndexNavigation'

const AGENT_INDEX_COMMAND_PREFIX = 'agent-index:'

export type AgentIndexPaletteQuery = {
  label: string
  intent: AgentIndexNavigationIntent
}

/**
 * Parse the command palette's exact agent-coordinate shorthand.
 *
 * WHY the optional bang is parsed here instead of in resolveAgentPaneLabel:
 * `A2` is a workspace coordinate shared by grid, Dispatch, and any future
 * navigation surface. `!` is invocation syntax owned by this palette. Keeping
 * the punctuation at the boundary prevents a UI-specific modifier from
 * becoming part of durable workspace identity or label ordering.
 */
export function parseAgentIndexPaletteQuery(
  input: string,
): AgentIndexPaletteQuery | null {
  const match = /^([a-z]+[1-9]\d*)(!)?$/i.exec(input.trim())
  if (!match?.[1]) return null
  return {
    label: match[1].toUpperCase(),
    intent: match[2]
      ? 'open-in-focused-tiled-dispatch-lane'
      : 'reuse-existing-view',
  }
}

export function buildAgentIndexCommand(
  target: AgentPaneLabelTarget,
  focusAgentByPaneLabel: (
    label: string,
    intent?: AgentIndexNavigationIntent,
  ) => Promise<boolean>,
  intent: AgentIndexNavigationIntent = 'reuse-existing-view',
): ResolvedCommand {
  const opensHere = intent === 'open-in-focused-tiled-dispatch-lane'
  return {
    id: `${AGENT_INDEX_COMMAND_PREFIX}${target.sessionId}`,
    title: opensHere
      ? `Open ${target.label} Here · ${target.title}`
      : `Go to ${target.label} · ${target.title}`,
    description: opensHere
      ? [
          `**What it does:** Shows live agent **${target.label}** in the currently focused Tiled Dispatch lane, even when another lane already shows it. Outside Tiled Dispatch, this behaves like the ordinary coordinate navigation.`,
          '',
          `**Target:** ${target.title} · ${target.tabTitle} · ${target.cwd}`,
          '',
          '**Notes:** Mirrors the same running session. It does not clone, resume, restart, or kill the agent.',
        ].join('\n')
      : [
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
      await focusAgentByPaneLabel(target.label, intent)
    },
  }
}

export function isAgentIndexCommand(command: ResolvedCommand): boolean {
  return command.id.startsWith(AGENT_INDEX_COMMAND_PREFIX)
}
