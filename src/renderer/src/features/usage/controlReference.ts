import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "usage",
    "title": "Provider usage",
    "purpose": "Inspect provider usage information and header summaries.",
    "ui": "Usage dialog and optional usage header.",
    "prerequisites": "Available provider/account usage data.",
    "workflow": [
      "Open Usage",
      "inspect the relevant provider/time context",
      "adjust workload if needed."
    ],
    "outcome": "Usage evidence is displayed.",
    "cautions": "A usage indicator is not an agent progress or completion signal.",
    "commandIds": [
      "usage.open"
    ]
  }
] satisfies FeatureReference[]
