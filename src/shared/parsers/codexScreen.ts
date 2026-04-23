// Re-export Codex screen parsers from the headless package.
// Renderer-side code imports from here instead of reaching into the
// submodule with fragile relative paths.
export {
  extractCodexAssistantInProgress,
  extractCodexStreamingText,
  detectCodexActivity,
} from 'codex-headless/parsers/ScreenParser'

export {
  detectCodexApproval,
  isApprovalOverlayVisible,
  type ScreenApproval,
} from 'codex-headless/parsers/ApprovalParser'
