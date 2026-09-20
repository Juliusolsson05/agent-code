import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "agent-analytics",
    "title": "Agent Analytics",
    "purpose": "See how much agent working time went to each project tab, repository, worktree and agent, so time spent on agents can be reviewed.",
    "ui": "Agent Analytics dialog with 24 hour, 7 day, 30 day and all-time ranges.",
    "prerequisites": "Working time recorded since the recorder shipped.",
    "workflow": [
      "Open Agent Analytics",
      "pick a range",
      "compare agent-hours and wall-clock hours per tab and expand a tab for repositories and worktrees."
    ],
    "outcome": "Agent working time per project and agent is displayed.",
    "cautions": "History is forward-only: nothing before recording began is shown. Agent-hours sum parallel agents while wall-clock counts overlapping time once. Machine sleep and time blocked on a permission prompt are excluded. Projects are grouped by tab title, so two tabs with the same title share one row.",
    "commandIds": [
      "agent-analytics.open"
    ]
  }
] satisfies FeatureReference[]
