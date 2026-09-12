import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "debug",
    "title": "Diagnostics, recording and support evidence",
    "purpose": "Inspect runtime/rendering failures and collect explicit diagnostic artifacts.",
    "ui": "Debug commands, developer panels and export/recording dialogs.",
    "prerequisites": "Some actions require developer/debug features or a live target.",
    "workflow": [
      "Inspect the failure",
      "choose a focused diagnostic or recording",
      "add context when exporting."
    ],
    "outcome": "A diagnostic view or artifact records the requested evidence.",
    "cautions": "Artifacts may contain task content. A recording is not a promise of complete provider history.",
    "commandIds": []
  }
] satisfies FeatureReference[]
