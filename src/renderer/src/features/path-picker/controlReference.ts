import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "path-picker",
    "title": "Project and directory picker",
    "purpose": "Choose the working directory for project/session actions.",
    "ui": "New Tab and other path-selection dialogs.",
    "prerequisites": "An accessible local path.",
    "workflow": [
      "Open the picker",
      "locate and inspect the directory",
      "confirm the intended destination."
    ],
    "outcome": "The calling action receives the selected path.",
    "cautions": "Selecting a directory is a separate step from creating a provider session.",
    "commandIds": [
      "new-tab"
    ]
  }
] satisfies FeatureReference[]
