import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "performance",
    "title": "Application performance",
    "purpose": "Inspect app/process performance and expensive runtime activity.",
    "ui": "Performance panel.",
    "prerequisites": "Available diagnostics for the current app run.",
    "workflow": [
      "Open performance",
      "identify the relevant process/session",
      "inspect the evidence before changing workload."
    ],
    "outcome": "The panel exposes measured performance information.",
    "cautions": "Performance values are not provider usage totals or task-completion signals.",
    "commandIds": [
      "toggle-performance-panel"
    ]
  }
] satisfies FeatureReference[]
