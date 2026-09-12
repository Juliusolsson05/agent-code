import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "ai-workspace",
    "title": "Curated AI Workspaces",
    "purpose": "Collect deliberate file/reference context for agent work.",
    "ui": "AI Workspace picker and editor integration.",
    "prerequisites": "An existing project or chosen files.",
    "workflow": [
      "Create or open a workspace",
      "add the desired references",
      "inspect the curated contents before sharing with an agent."
    ],
    "outcome": "The named context collection contains the intended references.",
    "cautions": "Clearing a curated collection is different from deleting the project files.",
    "commandIds": [
      "open-ai-workspace",
      "create-ai-workspace",
      "clear-ai-workspace"
    ]
  }
] satisfies FeatureReference[]
