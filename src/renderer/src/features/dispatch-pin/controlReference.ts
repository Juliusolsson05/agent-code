import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "pins",
    "title": "Pinned agents",
    "purpose": "Keep selected sessions easy to reach across project filters.",
    "ui": "Pin Agents dialog and Dispatch pinned section.",
    "prerequisites": "Existing agents.",
    "workflow": [
      "Select the exact sessions",
      "preserve the desired pin order",
      "reveal them through the pinned section."
    ],
    "outcome": "The same sessions remain prominent in the index.",
    "cautions": "Pinning changes visibility/order, not ownership or backend lifetime.",
    "commandIds": [
      "pin-agents",
      "unpin-agent"
    ]
  }
] satisfies FeatureReference[]
