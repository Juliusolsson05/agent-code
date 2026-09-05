import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "agent-status",
    "title": "Agent status and activity",
    "purpose": "Find sessions that are working, waiting or need attention.",
    "ui": "Agent Status panel and agent activity UI.",
    "prerequisites": "Existing workspace sessions.",
    "workflow": [
      "Open status",
      "inspect the relevant project/session",
      "reveal the agent needing attention."
    ],
    "outcome": "The operator reaches the existing agent with its status context.",
    "cautions": "Status is evidence about activity, not proof that the requested coding task is complete.",
    "commandIds": [
      "show-agent-status"
    ]
  }
] satisfies FeatureReference[]
