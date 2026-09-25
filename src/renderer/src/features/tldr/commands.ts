import { commandTarget } from '@renderer/features/command-palette/commandTarget'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { ReportHistoryKind } from '@renderer/app-state/uiShell/types'
import type { CommandContext, CommandDef } from '@renderer/features/command-palette/types'
import { toggle } from '@renderer/features/command-palette/commandState'
import { isPreviewVisible, toggleTldr, useTldrView } from './viewState'

// Both histories are offered for every agent, not only reporting-enabled ones:
// history outlives turning reporting off, and the modal explains when there is
// none. Terminals never report, so they never get the commands. Both resolve
// through `commandTarget`, never focus, because both are in the Sessions
// right-click menu, where the row clicked is usually not the focused agent.
function targetsAgent({ workspace, target }: CommandContext): boolean {
  const sessionId = commandTarget({ workspace, target })
  const meta = sessionId ? workspace.state.sessions[sessionId] : null
  return Boolean(meta && isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER))
}

function openHistory(kind: ReportHistoryKind): CommandDef['run'] {
  return ({ workspace, ui, target }) => {
    const sessionId = commandTarget({ workspace, target })
    if (!sessionId) return
    ui.closePalette()
    ui.openReportHistory(sessionId, kind)
  }
}

export const tldrCommands: CommandDef[] = [{
  id: 'tldr-preview', title: 'TLDR', category: 'navigate', surface: 'app',
  description: '**What it does:** Shows each visible agent’s saved TLDR centered over its pane.\n\n**Use when:** You want to scan progress and pending decisions across agents.\n\n**Notes:** Hold the shortcut to peek; release to dismiss. From the palette, press Escape to dismiss. Enable TLDR MCP for agents that should report summaries. Reading makes no model calls.',
  keywords: ['summary', 'summaries', 'status', 'peek', 'hold', 'decision'],
  getState: () => toggle(isPreviewVisible(useTldrView.getState(), 'tldr')),
  run: ({ ui }) => { ui.closePalette(); toggleTldr('tldr') },
}, {
  id: 'goal-preview', title: 'Goal', category: 'navigate', surface: 'app',
  description: '**What it does:** Shows each visible agent’s goal — what its work is for — centered over its pane.\n\n**Use when:** You have many agents open and need to know what each one is trying to achieve, not just its latest status.\n\n**Notes:** Hold the shortcut to peek; release to dismiss. From the palette, press Escape to dismiss. Enable Goal MCP for agents that should record goals. Reading makes no model calls.',
  keywords: ['goal', 'purpose', 'objective', 'intent', 'why', 'peek', 'hold'],
  getState: () => toggle(isPreviewVisible(useTldrView.getState(), 'goal')),
  run: ({ ui }) => { ui.closePalette(); toggleTldr('goal') },
}, {
  id: 'view-tldr-history', title: 'View TLDR History', category: 'session', surface: 'session',
  description: '**What it does:** Shows every saved TLDR and goal change for the focused **agent**, newest first.\n\n**Use when:** You want to see how an agent’s status and direction evolved — milestones, outcome and any change of goal — rather than only where it is now.\n\n**Notes:** Keeps the latest 100 TLDR updates and 100 goal changes per agent. History follows the conversation across reloads and provider switches; a duplicate or rewind starts fresh.',
  keywords: ['tldr', 'goal', 'history', 'summary', 'status', 'timeline', 'progress'],
  when: targetsAgent,
  run: openHistory('tldr'),
  contextMenu: { group: 'agent', order: 70, title: 'TLDR History…' },
}, {
  id: 'view-goal-history', title: 'View Goal History', category: 'session', surface: 'session',
  description: '**What it does:** Shows every goal the focused **agent** set, and each time it completed one, newest first.\n\n**Use when:** You want to know what an agent has been working toward over its life without reading every status update in between.\n\n**Notes:** Keeps the latest 100 goal changes per agent. View TLDR History shows the same goals mixed in with status updates. History follows the conversation across reloads and provider switches; a duplicate or rewind starts fresh.',
  keywords: ['goal', 'history', 'purpose', 'objective', 'intent', 'completed', 'timeline'],
  when: targetsAgent,
  run: openHistory('goal'),
  contextMenu: { group: 'agent', order: 75, title: 'Goal History…' },
}]
