import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "usage",
    "title": "Provider usage",
    "purpose": "Inspect provider usage information, header summaries, and provider-reported usage caps.",
    "ui": "Usage dialog, optional usage header, and usage-limit notices in Feed and Reader.",
    "prerequisites": "Available provider/account usage data.",
    "workflow": [
      "Open Usage",
      "inspect the relevant provider/time context",
      "adjust workload if needed."
    ],
    "outcome": "Usage evidence is displayed.",
    "cautions": "usage.read returns quota/cache/error evidence through the existing provider reader, without exposing credentials. A usage indicator is not an agent progress or completion signal. Cap notices preserve the provider report; a reset time is not proof of recovery. Claude monthly spend caps are distinct from session resets. Codex notices require structured proxy errors and survive only within bounded live runtime history; native history cannot restore them after restart.",
    "commandIds": [
      "usage.open"
    ]
  }
] satisfies FeatureReference[]
