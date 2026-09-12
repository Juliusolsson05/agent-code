import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "command-palette",
    "title": "Command picker and intention search",
    "purpose": "Find operations without remembering every shortcut, including alternate picker modes.",
    "ui": "Command picker; shipped default Cmd+Shift+P, subject to customization.",
    "prerequisites": "The intended window and relevant session/project context.",
    "workflow": [
      "Search by title, keyword or description",
      "read the command",
      "select it",
      "finish any opened dialog."
    ],
    "outcome": "The picker invokes the selected command or hands off to its interactive surface.",
    "cautions": "Opening or selecting a row is not the same as submitting it. Contextual admission can refuse a listed command. commands.run uses that same admission and can require the observed selected session; dispatcher completion does not imply a dialog or background task completed.",
    "commandIds": [
      "open-command-palette"
    ]
  }
] satisfies FeatureReference[]
