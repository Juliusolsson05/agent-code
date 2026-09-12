import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "cli-updates",
    "title": "Provider CLI updates",
    "purpose": "Inspect and manage provider tool versions and update progress.",
    "ui": "Setup and CLI update notices.",
    "prerequisites": "Installed provider tools and network access where an update requires it.",
    "workflow": [
      "Read the update state",
      "use the supported update action",
      "observe completion and any session implications."
    ],
    "outcome": "The app reports the detected or updated CLI version.",
    "cautions": "Changing CLI versions is not a conversation operation; active runtimes may need their own restart path.",
    "commandIds": []
  }
] satisfies FeatureReference[]
