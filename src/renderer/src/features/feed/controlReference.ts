import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "conversation",
    "title": "Rendered conversations and provider conditions",
    "purpose": "Read prompts, assistant messages, tools, results and interactive provider conditions.",
    "ui": "Agent pane conversation feed.",
    "prerequisites": "A supported rendered agent view and available live/history data.",
    "workflow": [
      "Read progress",
      "expand relevant tool details",
      "respond to supported conditions",
      "follow the newest output when desired."
    ],
    "outcome": "Conversation and required interaction are visible for the correct session.",
    "cautions": "The rendered feed reconciles live and committed data. Raw tool noise and visible assistant messages are different read depths.",
    "commandIds": []
  }
] satisfies FeatureReference[]
