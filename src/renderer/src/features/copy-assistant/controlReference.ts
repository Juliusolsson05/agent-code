import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "copy-assistant",
    "title": "Copy assistant messages",
    "purpose": "Select and copy a visible assistant response.",
    "ui": "Copy Assistant Message picker on a rendered conversation.",
    "prerequisites": "A rendered assistant message.",
    "workflow": [
      "Open the picker",
      "select the intended message",
      "copy",
      "verify the clipboard target."
    ],
    "outcome": "The chosen response is copied.",
    "cautions": "A response can have intermediate siblings; select the specific message needed.",
    "commandIds": [
      "copy-assistant-message"
    ]
  }
] satisfies FeatureReference[]
