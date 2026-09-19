import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "setup",
    "title": "First-run provider and toolchain setup",
    "purpose": "Show which agent CLIs and helper tools this Mac has, and how to add the missing ones.",
    "ui": "The Setup panel: opens by itself when no provider is usable, or on request from File › Setup… or Open Setup.",
    "prerequisites": "None. No single tool blocks launch: any one provider is enough for agents, and a terminal pane needs none.",
    "workflow": [
      "Open Setup",
      "copy a missing provider's install command and run it in a terminal pane",
      "press Retry, or enter the CLI's path manually if the probe misses it."
    ],
    "outcome": "The provider becomes available for new agents. A fresh install opens its first project with the default provider when usable, otherwise the first usable one, otherwise a terminal.",
    "cautions": "A found CLI may still be signed out; provider login and permission rules remain provider-owned.",
    "commandIds": ["open-setup"]
  }
] satisfies FeatureReference[]
