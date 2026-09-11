import type { FeatureReference } from '@control-sdk'

export const controlReference = [{
  id: 'tldr',
  title: 'TLDR agent summaries',
  purpose: 'Scan outcomes, next steps and pending decisions across visible agents.',
  ui: 'TLDR MCP per-agent command, optional new-agent default in Settings, and TLDR preview command.',
  prerequisites: 'Enable TLDR MCP for each agent that should report. Reporting is off by default.',
  workflow: [
    'Enable TLDR MCP for the agent; it reloads with the managed reporting skill.',
    'The agent replaces its short summary after substantial work or discussion.',
    'Hold the TLDR shortcut to peek and release to dismiss, or open TLDR from the palette and dismiss with Escape.',
  ],
  outcome: 'Each visible agent pane shows its own latest saved summary in centered white text over a dark overlay.',
  cautions: 'Reading summaries makes no model calls. A summary describes the last report, not live activity or permission to act. Minor unchanged clarifications need no update. The editor retains its native Select Line shortcut.',
  commandIds: ['enable-tldr-mcp', 'tldr-preview'],
}] satisfies FeatureReference[]
