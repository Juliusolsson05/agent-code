import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "workflows",
    "title": "Existing workflow runs",
    "purpose": "Coordinate longer work with explicit runs and workers.",
    "ui": "Workflow surfaces and supported workflow operations.",
    "prerequisites": "An available workflow and its required configuration.",
    "workflow": [
      "Choose the workflow",
      "inspect inputs",
      "start it",
      "monitor run/worker state",
      "inspect outputs."
    ],
    "outcome": "The workflow run exposes its state and outputs.",
    "cautions": "A workflow has its own ownership and lifecycle; it is not an anonymous internal agent.",
    "commandIds": []
  }
] satisfies FeatureReference[]
