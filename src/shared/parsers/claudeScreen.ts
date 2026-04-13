// Re-export Claude screen parsers from the headless package.
// Renderer-side code imports from here instead of reaching into the
// submodule with fragile relative paths.
export {
  extractAssistantInProgress,
  extractStreamingText,
  detectActivity,
} from '../../../claude-code-headless/src/parsers/ScreenParser'

export {
  detectTrustDialog,
  type TrustDialogState,
} from '../../../claude-code-headless/src/parsers/TrustDialogParser'

export {
  detectResumePrompt,
  type ResumePromptState,
} from '../../../claude-code-headless/src/parsers/ResumePromptParser'
