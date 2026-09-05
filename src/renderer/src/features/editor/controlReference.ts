import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "read-only-documents",
    "title": "Document and read-only viewing",
    "purpose": "Inspect document content through the app viewing surfaces.",
    "ui": "Document viewers and file/code links.",
    "prerequisites": "A supported document or selected content.",
    "workflow": [
      "Open the reference",
      "inspect the content",
      "use the editor when a real edit is intended."
    ],
    "outcome": "The requested document is visible.",
    "cautions": "A read-only viewer does not imply that an editor buffer or disk file changed.",
    "commandIds": []
  }
] satisfies FeatureReference[]
