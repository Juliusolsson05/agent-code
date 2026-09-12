import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "copy-code-block",
    "title": "Copy code blocks",
    "purpose": "Extract a particular code block from rendered messages.",
    "ui": "Copy Code Block picker.",
    "prerequisites": "Rendered code blocks in the target session.",
    "workflow": [
      "Open the picker",
      "move to the block",
      "confirm the copy."
    ],
    "outcome": "The chosen block is copied.",
    "cautions": "Copied text is not executed or saved automatically.",
    "commandIds": [
      "copy-code-block"
    ]
  }
] satisfies FeatureReference[]
