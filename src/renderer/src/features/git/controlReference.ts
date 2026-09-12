import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "git",
    "title": "Git project inspection",
    "purpose": "Inspect repository context while agents work.",
    "ui": "Git panel and project controls.",
    "prerequisites": "A Git repository in the selected project.",
    "workflow": [
      "Open Git context",
      "check branch and changes",
      "inspect the relevant diff before deciding the next operation."
    ],
    "outcome": "Repository state is visible alongside agent work.",
    "cautions": "A displayed diff is not a commit, push or merge authorization.",
    "commandIds": []
  }
] satisfies FeatureReference[]
