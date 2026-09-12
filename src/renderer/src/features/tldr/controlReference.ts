import type { FeatureReference } from '@control-sdk'

export const controlReference = [{
  id: 'tldr',
  title: 'TLDR agent summaries and goals',
  purpose: 'Scan outcomes, next steps and pending decisions across visible agents, and what each agent is for.',
  ui: 'TLDR MCP and Goal MCP per-agent commands, TLDR MCP and Goal MCP settings, TLDR and Goal preview commands, and View TLDR History command.',
  prerequisites: 'Enable TLDR MCP for each agent that should report status, and Goal MCP for each agent that should record its goal. The two are independent and both off by default.',
  workflow: [
    'Enable TLDR MCP for the agent; it reloads with the managed reporting skill.',
    'The agent replaces its short summary after substantial work or discussion.',
    'Hold the TLDR shortcut to peek and release to dismiss, or open TLDR from the palette and dismiss with Escape.',
    'Open View TLDR History to read how the focused agent’s status evolved, newest first.',
    'Enable Goal MCP for an agent; it records what its work is for. Hold the Goal shortcut to peek at goals.',
  ],
  outcome: 'Each visible agent pane shows its own latest saved summary, or with the Goal preview its recorded goal, in centered white text over a dark overlay.',
  cautions: 'Reading summaries makes no model calls. Claude and Codex agents are asked to update at turn end when they used tools without reporting; they may decline when nothing changed. A summary describes the last report, not live activity or permission to act. Minor unchanged clarifications need no update. Goals are written by the agent and change only when its direction changes; users cannot edit them. The editor retains its native Select Line and Find Next shortcuts.',
  commandIds: ['enable-tldr-mcp', 'tldr-preview', 'view-tldr-history', 'enable-goal-mcp', 'goal-preview'],
}] satisfies FeatureReference[]
