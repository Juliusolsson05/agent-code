import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "keybindings",
    "title": "Commands and keyboard shortcuts",
    "purpose": "Inspect defaults, customize bindings, explicitly unbind commands and restore defaults.",
    "ui": "Settings → Commands & Shortcuts and the shortcut reference.",
    "prerequisites": "A command in the current catalog; contextual and fixed inputs also own keys.",
    "workflow": [
      "Find the command",
      "inspect effective/default chords and context",
      "edit or reset",
      "verify the new effective mapping."
    ],
    "outcome": "The displayed mapping agrees with the current settings and command router.",
    "cautions": "An empty override explicitly unbinds; deleting the override restores inheritance. Hidden picker commands can still be bound.",
    "commandIds": []
  }
] satisfies FeatureReference[]
