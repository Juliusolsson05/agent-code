import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "prompt-templates",
    "title": "Reusable prompt templates",
    "purpose": "Reuse, edit and save structured prompts.",
    "ui": "Prompt Template picker, management UI and composer-save command.",
    "prerequisites": "An existing template or draft to save.",
    "workflow": [
      "Choose a template",
      "fill its relevant context",
      "inspect the resulting draft/prompt",
      "submit deliberately."
    ],
    "outcome": "The intended prompt text is available for the target agent.",
    "cautions": "Template selection, draft insertion and prompt delivery have different completion states.",
    "commandIds": [
      "prompt-template",
      "manage-prompt-templates",
      "save-composer-as-prompt-template"
    ]
  }
] satisfies FeatureReference[]
