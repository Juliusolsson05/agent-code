import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "global-editor",
    "title": "File tree, editor buffers, quick open and search",
    "purpose": "Navigate and edit project files with tabs, save controls and language-service support.",
    "ui": "Global Editor and its file tree, quick-open and search surfaces.",
    "prerequisites": "An accessible file/project; edits must respect buffer and disk versions.",
    "workflow": [
      "Open the editor",
      "find a file",
      "inspect or edit",
      "save the intended buffer",
      "handle conflicts explicitly."
    ],
    "outcome": "The selected file and buffer state are visible; saves report their outcome.",
    "cautions": "Unsaved buffers can differ from disk. Editor focus owns its own keyboard interactions.",
    "commandIds": [
      "toggle-global-editor",
      "quick-open-file",
      "search-in-files",
      "save-editor-file",
      "save-all-editor-files",
      "toggle-file-tree"
    ]
  }
] satisfies FeatureReference[]
