import type { FeatureReference } from '@control-sdk'

// Keep purpose, UI routes and limitations beside this feature. The assembled
// control reference adds current commands/bindings instead of copying them.
export const controlReference = [
  {
    "id": "dictation",
    "title": "Voice dictation and history",
    "purpose": "Turn speech into composer text through the configured speech provider.",
    "ui": "Dictation controls, shortcut/mouse trigger, settings and history.",
    "prerequisites": "Configured speech provider and microphone permission.",
    "workflow": [
      "Start recording",
      "speak",
      "stop",
      "review the transcribed text",
      "submit deliberately."
    ],
    "outcome": "Transcribed text is available in the intended composer/history.",
    "cautions": "Keyboard hotkeys can have global scope; mouse triggers are app-local. Transcription and prompt submission are distinct.",
    "commandIds": []
  }
] satisfies FeatureReference[]
