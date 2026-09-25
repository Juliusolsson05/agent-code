import type { FeatureReference } from '@control-sdk'

// The Sessions list right-click menu (#1180). Its items are catalog commands
// that opted in with `contextMenu` metadata, so `commandIds` lists exactly
// those — featureReference.test.ts then fails if one is retired without this
// page following.
export const controlReference = [
  {
    "id": "session-context-menu",
    "title": "Sessions list right-click menu",
    "purpose": "Act on any agent in the Sessions list without first bringing it into a lane.",
    "ui": "Right-click a row in the Sessions list (project or Pinned section), or press the ContextMenu key or Shift+F10 on a focused row. A native menu opens for that agent.",
    "prerequisites": "An agent or terminal in the Sessions list.",
    "workflow": [
      "Right-click the row; it stays unselected and is highlighted while its menu is open",
      "choose Show in Lane or Spotlight, set its title or color flag, pin it, run an agent action, copy, or close it",
      "the action applies to that row's agent, not the focused one."
    ],
    "outcome": "The chosen action runs on the clicked agent. Items that do not apply to it (for example agent actions on a terminal) are omitted.",
    "cautions": "Close Agent uses the normal close path, so a working agent still asks for confirmation. If the agent closed or reloaded while the menu was open, the choice is dropped with a notice rather than applied to another agent.",
    "commandIds": [
      "agent.title.set",
      "pin-agent",
      "unpin-agent",
      "reload-agent",
      "switch-provider",
      "agent-mcp-servers",
      "duplicate-agent",
      "rewind-to-prompt",
      "view-prompts",
      "view-tldr-history",
      "view-goal-history",
      "goal-loop-stop",
      "copy-resume-command",
      "copy-last-assistant",
      "close-pane"
    ]
  }
] satisfies FeatureReference[]
