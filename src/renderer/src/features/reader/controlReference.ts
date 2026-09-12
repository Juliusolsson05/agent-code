import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "reader",
    "title": "Reader Mode",
    "purpose": "Browse long conversations in a focused paginated view.",
    "ui": "Reader Mode for the selected session.",
    "prerequisites": "Available session conversation history and a compatible view.",
    "workflow": [
      "Open Reader",
      "page through history",
      "inspect the needed message",
      "return to the workspace."
    ],
    "outcome": "The requested history slice is visible.",
    "cautions": "Reader navigation does not itself rewind or alter the provider conversation.",
    "commandIds": [
      "toggle-reader-mode"
    ]
  }
] satisfies FeatureReference[]
