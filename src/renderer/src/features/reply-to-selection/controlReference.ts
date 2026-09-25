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
  },
  {
    "id": "reply-to-reader-message",
    "title": "Reply to the Reader's message",
    "purpose": "Quote a whole assistant message from the keyboard, where no text selection is possible.",
    "ui": "In Reader Mode, pick the message with Older / Newer (Option+Up / Option+Down), then run Reply to Reader Message from the palette.",
    "prerequisites": "Reader Mode open on an agent, with an assistant message shown.",
    "workflow": [
      "Open Reader Mode",
      "pick the message",
      "invoke Reply to Reader Message",
      "edit the follow-up",
      "submit to the agent being read."
    ],
    "outcome": "The composer of the agent being read contains the quoted message above the existing draft.",
    "cautions": "A prepared reply is not a delivered prompt. The quote goes to the agent Reader shows, not to the focused grid pane.",
    "commandIds": [
      "reply-to-reader-message"
    ]
  }
] satisfies FeatureReference[]
