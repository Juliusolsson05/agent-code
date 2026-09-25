import type { FeatureReference } from '@control-sdk'

export const controlReference = [{
  id: 'tldr',
  title: 'TLDR agent summaries and goals',
  purpose: 'Scan outcomes, next steps and pending decisions across visible agents, and what each agent is for.',
  ui: 'TLDR and Goal rows in Settings → MCP (per provider) and in the Agent MCP Servers picker (per agent), TLDR and Goal preview commands, and the View TLDR History and View Goal History commands.',
  prerequisites: 'Turn TLDR on for agents that should report status, and Goal for agents that should record their goal: per provider in Settings → MCP, or for one agent with Agent MCP Servers. The two are independent.',
  workflow: [
    'Turn TLDR on for the agent in Agent MCP Servers; it reloads with the managed reporting skill.',
    'The agent replaces its short summary after substantial work or discussion.',
    'Hold the TLDR shortcut to peek and release to dismiss, or open TLDR from the palette and dismiss with Escape.',
    'Open View TLDR History to read how the focused agent’s status evolved, newest first.',
    'Turn Goal on for an agent the same way; it records what its work is for. Hold the Goal shortcut to peek at goals.',
    'Open View Goal History to read only the focused agent’s goal changes and completions, newest first.',
    'Once you accept an agent’s work (for example its PR merged), the agent marks its goal complete; run Close Completed Agents… to close the finished agents you keep ticked and, optionally, remove their lanes.',
  ],
  outcome: 'Each visible agent pane shows its own latest saved summary, or with the Goal preview its recorded goal, in centered text over an overlay in the app’s background color.',
  cautions: 'Reading summaries makes no model calls. Claude and Codex agents are asked to update at turn end when they used tools without reporting; they may decline when nothing changed. A summary describes the last report, not live activity or permission to act. Minor unchanged clarifications need no update. Goals are written by the agent and change only when its direction changes; users cannot edit them. An agent marks its goal complete only after the user accepted the result, and setting a new goal clears the completion; Close Completed Agents… never closes a running agent. The editor retains its native Select Line and Find Next shortcuts.',
  commandIds: ['agent-mcp-servers', 'tldr-preview', 'view-tldr-history', 'goal-preview', 'view-goal-history', 'close-completed-agents'],
}] satisfies FeatureReference[]
