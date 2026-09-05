import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "caffeinate",
    "title": "Keep awake",
    "purpose": "Control sleep prevention while local work is running.",
    "ui": "Keep-awake command and status/toast.",
    "prerequisites": "Platform sleep-prevention support.",
    "workflow": [
      "Enable keep-awake for the work interval",
      "confirm its state",
      "disable it when finished."
    ],
    "outcome": "Sleep-prevention state changes visibly.",
    "cautions": "This does not guarantee that a provider remains connected or a task succeeds.",
    "commandIds": [
      "toggle-caffeinate"
    ]
  }
] satisfies FeatureReference[]
