import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
//
// WHY this page lives in performance-monitor and still answers to the
// "performance" id: the monitor is the product surface for the performance
// feature that the old debug panel started. Keeping the historical id means
// existing links and muscle memory keep working while there is exactly one
// page for the capability.
export const controlReference = [
  {
    "id": "performance",
    "title": "Application performance",
    "purpose": "See what Agent Code's processes and agents are using, and attribute memory and CPU to the agent responsible.",
    "ui": "Performance Monitor dialog: totals, memory/CPU charts with hover, agents ranked by resource use, processes, timeline and incidents.",
    "prerequisites": "Available diagnostics for the current app run.",
    "workflow": [
      "Open performance",
      "read the totals for overall pressure",
      "rank agents by memory, CPU or growth and identify the responsible agent",
      "inspect processes, history or incidents for evidence before changing workload."
    ],
    "outcome": "The monitor attributes measured resource use to specific agents.",
    "cautions": "Performance values are observations, not a guarantee of what caused a slowdown; resident memory can double-count pages shared between processes.",
    "commandIds": [
      "toggle-performance-panel",
      "save-performance-report",
      "record-performance-trace"
    ]
  }
] satisfies FeatureReference[]
