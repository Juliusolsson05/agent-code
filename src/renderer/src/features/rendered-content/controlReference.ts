import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "rendered-content",
    "title": "Links and rendered file references",
    "purpose": "Open relevant files and external references from messages safely through app routes.",
    "ui": "Links and file references in rendered messages and code blocks.",
    "prerequisites": "A supported link or file target.",
    "workflow": [
      "Inspect the link",
      "open its app/editor/browser route",
      "confirm the destination."
    ],
    "outcome": "The referenced content opens in the intended surface.",
    "cautions": "A link is content, not an instruction to run a shell command.",
    "commandIds": []
  }
] satisfies FeatureReference[]
