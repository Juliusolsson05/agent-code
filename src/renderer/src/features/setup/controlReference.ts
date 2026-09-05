import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "setup",
    "title": "First-run provider and toolchain setup",
    "purpose": "Establish the native tools Agent Code needs.",
    "ui": "Setup gate and setup settings.",
    "prerequisites": "Supported platform and required provider/tool availability.",
    "workflow": [
      "Review missing tools",
      "complete installation/authentication through supported flows",
      "recheck readiness."
    ],
    "outcome": "The chosen provider/runtime becomes available for session creation.",
    "cautions": "Provider login and permission rules remain provider-owned.",
    "commandIds": []
  }
] satisfies FeatureReference[]
