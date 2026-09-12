import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { CommandDef } from '@renderer/features/command-palette/types'
import { toggle } from '@renderer/features/command-palette/commandState'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { isPreviewVisible, toggleTldr, useTldrView } from './viewState'

export const tldrCommands: CommandDef[] = [{
  id: 'tldr-preview', title: 'TLDR', category: 'navigate', surface: 'app',
  description: '**What it does:** Shows each visible agent’s saved TLDR centered over its darkened pane.\n\n**Use when:** You want to scan progress and pending decisions across agents.\n\n**Notes:** Hold the shortcut to peek; release to dismiss. From the palette, press Escape to dismiss. Enable TLDR MCP for agents that should report summaries. Reading makes no model calls.',
  keywords: ['summary', 'summaries', 'status', 'peek', 'hold', 'decision'],
  getState: () => toggle(isPreviewVisible(useTldrView.getState(), 'tldr')),
  run: ({ ui }) => { ui.closePalette(); toggleTldr('tldr') },
}, {
  id: 'goal-preview', title: 'Goal', category: 'navigate', surface: 'app',
  description: '**What it does:** Shows each visible agent’s goal — what its work is for — centered over its darkened pane.\n\n**Use when:** You have many agents open and need to know what each one is trying to achieve, not just its latest status.\n\n**Notes:** Hold the shortcut to peek; release to dismiss. From the palette, press Escape to dismiss. Enable Goal MCP for agents that should record goals. Reading makes no model calls.',
  keywords: ['goal', 'purpose', 'objective', 'intent', 'why', 'peek', 'hold'],
  getState: () => toggle(isPreviewVisible(useTldrView.getState(), 'goal')),
  run: ({ ui }) => { ui.closePalette(); toggleTldr('goal') },
}, {
  id: 'view-tldr-history', title: 'View TLDR History', category: 'session', surface: 'session',
  description: '**What it does:** Shows every saved TLDR and goal change for the focused **agent**, newest first.\n\n**Use when:** You want to see how an agent’s status and direction evolved — milestones, outcome and any change of goal — rather than only where it is now.\n\n**Notes:** Keeps the latest 100 TLDR updates and 100 goal changes per agent. History follows the conversation across reloads and provider switches; a duplicate or rewind starts fresh.',
  keywords: ['tldr', 'goal', 'history', 'summary', 'status', 'timeline', 'progress'],
  // Offered for every agent pane, not only TLDR-enabled ones: history outlives
  // turning reporting off, and the modal explains when there is none.
  when: ({ workspace }) => {
    const sessionId = commandTargetSessionId(workspace)
    const meta = sessionId ? workspace.state.sessions[sessionId] : null
    return Boolean(meta && isAgentProviderKind(meta.kind ?? DEFAULT_PROVIDER))
  },
  run: ({ workspace, ui }) => {
    const sessionId = commandTargetSessionId(workspace)
    if (!sessionId) return
    ui.closePalette()
    ui.openTldrHistory(sessionId)
  },
}]
