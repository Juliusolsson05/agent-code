import type { CommandDef } from '@renderer/features/command-palette/types'
import { toggle } from '@renderer/features/command-palette/commandState'
import { toggleTldr, useTldrView } from './viewState'

export const tldrCommands: CommandDef[] = [{
  id: 'tldr-preview', title: 'TLDR', category: 'navigate', surface: 'app',
  description: '**What it does:** Shows each visible agent’s saved TLDR centered over its darkened pane.\n\n**Use when:** You want to scan progress and pending decisions across agents.\n\n**Notes:** Hold the shortcut to peek; release to dismiss. From the palette, press Escape to dismiss. Enable TLDR MCP for agents that should report summaries. Reading makes no model calls.',
  keywords: ['summary', 'summaries', 'status', 'peek', 'hold', 'decision'],
  getState: () => { const state = useTldrView.getState(); return toggle(state.held || state.latched) },
  run: ({ ui }) => { ui.closePalette(); toggleTldr() },
}]
