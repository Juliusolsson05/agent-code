import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "agent-activity",
    "title": "Agent Activity",
    "purpose": "See at a glance which agents need the user, which are working and on what, and which are idle or exited and can be closed.",
    "ui": "Modal with Needs you, Working, Idle and Exited sections, a filter field, and multi-select close.",
    "prerequisites": "None. Agent names use the Goal and the second line uses the TLDR only for agents with those MCP domains enabled.",
    "workflow": [
      "Open Agent Activity",
      "read the Needs you section for agents waiting on a permission, a question, a failed turn, a usage limit, an unsent prompt or a paused goal loop",
      "type to filter, Space to select rows, and ⌫ to close the selection after confirming."
    ],
    "outcome": "Every agent in the window, lane or pool, is listed with why it needs attention; selected agents are closed after one confirmation.",
    "cautions": "Grok agents never show a failed turn because Grok has no failure signal. A row named by its folder means nobody set a title or a Goal. Closing from here records no Undo Close entry. Close Old Agents and Close Idle Orchestration Agents remain the one-shot cleanup commands.",
    "commandIds": [
      "open-agent-activity"
    ]
  }
] satisfies FeatureReference[]
