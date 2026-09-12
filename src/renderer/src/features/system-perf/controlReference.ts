import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "system-performance",
    "title": "System performance evidence",
    "purpose": "Relate application workload to system resource pressure.",
    "ui": "System performance information within diagnostics/performance UI.",
    "prerequisites": "Available platform metrics.",
    "workflow": [
      "Inspect resource pressure alongside relevant sessions",
      "decide whether to reduce workload."
    ],
    "outcome": "Measured system context is available.",
    "cautions": "Metrics are observations, not a guarantee of what caused a slowdown.",
    "commandIds": []
  }
] satisfies FeatureReference[]
