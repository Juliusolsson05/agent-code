import type { FeatureReference } from '@control-sdk'

export const controlReference = [{
  id: 'tldr',
  title: 'TLDR agent summaries',
  purpose: 'Scan outcomes, next steps and pending decisions across visible agents.',
  ui: 'TLDR MCP per-agent command, TLDR MCP setting, TLDR preview command, and View TLDR History command.',
  prerequisites: 'Enable TLDR MCP for each agent that should report. Reporting is off by default.',
  workflow: [
    'Enable TLDR MCP for the agent; it reloads with the managed reporting skill.',
    'The agent replaces its short summary after substantial work or discussion.',
    'Hold the TLDR shortcut to peek and release to dismiss, or open TLDR from the palette and dismiss with Escape.',
    'Open View TLDR History to read how the focused agent’s status evolved, newest first.',
  ],
  outcome: 'Each visible agent pane shows its own latest saved summary in centered white text over a dark overlay.',
  cautions: 'Reading summaries makes no model calls. Claude and Codex agents are asked to update at turn end when they used tools without reporting; they may decline when nothing changed. A summary describes the last report, not live activity or permission to act. Minor unchanged clarifications need no update. The editor retains its native Select Line shortcut.',
  commandIds: ['enable-tldr-mcp', 'tldr-preview', 'view-tldr-history'],
}] satisfies FeatureReference[]
