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
  // A terminal has no provider process to resume/clone/restart — it is a
  // plain shell pane, not an agent session. Before #865 `buildAgentPaneLabelTarget`
  // filtered terminals out with `isAgentProviderKind`, so this row could only
  // ever describe an agent and the copy hardcoded that word. Terminals now
  // reach this exact function, so the copy must name the actual kind or it
  // reads as a lie for a shell ("Focuses live agent A1" pointing at a shell).
  const isTerminal = target.kind === 'terminal'
  const subject = isTerminal ? 'terminal' : 'agent'
  const lifecycleNote = isTerminal
    ? `It does not clone, restart, or kill the ${subject}.`
    : `It does not clone, resume, restart, or kill the ${subject}.`
  return {
    id: `${AGENT_INDEX_COMMAND_PREFIX}${target.sessionId}`,
    title: opensHere
      ? `Open ${target.label} Here · ${target.title}`
      : `Go to ${target.label} · ${target.title}`,
    description: opensHere
      ? [
          `**What it does:** Shows live ${subject} **${target.label}** in the currently focused Tiled Dispatch lane, even when another lane already shows it.`,
          '',
          `**Target:** ${target.title} · ${target.tabTitle} · ${target.cwd}`,
          '',
          `**Notes:** Mirrors the same running session. ${lifecycleNote}`,
        ].join('\n')
      : [
          `**What it does:** Focuses live ${subject} **${target.label}** in its existing view, or shows it in the currently focused view slot.`,
          '',
          `**Target:** ${target.title} · ${target.tabTitle} · ${target.cwd}`,
          '',
          `**Notes:** Reuses the running session. ${lifecycleNote}`,
          '',
          `**Tip:** Type \`${target.label}!\` to show this same ${subject} in the currently focused Tiled Dispatch lane.`,
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
