import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "worktrees",
    "title": "Worktrees and active checkout context",
    "purpose": "Inspect separate checkouts and activity associated with agent work.",
    "ui": "Worktrees panel, project context and worktree badges.",
    "prerequisites": "A repository with relevant checkouts.",
    "workflow": [
      "Find the intended checkout",
      "inspect branch/path/activity",
      "target the agent to that directory."
    ],
    "outcome": "The operator can distinguish checkouts and their work.",
    "cautions": "A worktree path and a visual tab are different things. Activity evidence can lag a backend transition.",
    "commandIds": []
  }
] satisfies FeatureReference[]
