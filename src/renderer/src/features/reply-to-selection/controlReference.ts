import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "reply-to-selection",
    "title": "Reply to selected text",
    "purpose": "Carry a precise quotation into a follow-up prompt.",
    "ui": "Select text in the rendered conversation, then Reply to Selection.",
    "prerequisites": "A supported rendered selection and target composer.",
    "workflow": [
      "Select the passage",
      "invoke reply",
      "edit the follow-up",
      "submit to the intended agent."
    ],
    "outcome": "The composer contains the selected reference for the reply.",
    "cautions": "A prepared reply is not a delivered prompt.",
    "commandIds": [
      "reply-to-selection"
    ]
  }
] satisfies FeatureReference[]
