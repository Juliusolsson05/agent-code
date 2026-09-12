import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "spotlight",
    "title": "Spotlight session view",
    "purpose": "Temporarily emphasize one session without restructuring the workspace.",
    "ui": "Spotlight command and overlay.",
    "prerequisites": "A selected session.",
    "workflow": [
      "Open Spotlight",
      "inspect or interact",
      "exit to the previous workspace layout."
    ],
    "outcome": "The chosen session occupies the focused view.",
    "cautions": "Spotlight is a view change, not a new agent.",
    "commandIds": [
      "toggle-spotlight"
    ]
  }
] satisfies FeatureReference[]
