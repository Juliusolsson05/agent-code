import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "session-preview",
    "title": "Session previews",
    "purpose": "Inspect a session briefly while choosing where to navigate.",
    "ui": "Session and agent picker previews.",
    "prerequisites": "A session with previewable content.",
    "workflow": [
      "Inspect the preview",
      "confirm identity",
      "open the existing session if needed."
    ],
    "outcome": "The operator can choose a session with context.",
    "cautions": "A preview can be bounded and is not the complete conversation.",
    "commandIds": []
  }
] satisfies FeatureReference[]
