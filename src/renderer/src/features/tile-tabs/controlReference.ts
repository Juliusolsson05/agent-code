import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "tiled-tabs",
    "title": "Several project tabs side by side",
    "purpose": "Display multiple project contexts in one workspace.",
    "ui": "Tiled Tabs configuration and layout.",
    "prerequisites": "Open project tabs.",
    "workflow": [
      "Select tabs to display",
      "arrange their sizes",
      "focus the intended tab and pane."
    ],
    "outcome": "Several project tabs are visible without merging their session ownership.",
    "cautions": "Tab focus and session focus are separate. Replacing a displayed tab should preserve the other views.",
    "commandIds": []
  }
] satisfies FeatureReference[]
