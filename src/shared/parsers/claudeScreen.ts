// Re-export Claude screen parsers from the headless package.
// Renderer-side code imports from here instead of reaching into the
// submodule with fragile relative paths.
export {
  extractAssistantInProgress,
  extractStreamingText,
  detectActivity,
} from 'claude-code-headless/parsers/ScreenParser'

export {
  detectTrustDialog,
  type TrustDialogState,
} from 'claude-code-headless/parsers/TrustDialogParser'

export {
  detectResumePrompt,
  type ResumePromptState,
} from 'claude-code-headless/parsers/ResumePromptParser'
