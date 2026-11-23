// Public surface of antigravity-acp-headless.

export { AntigravityAcpSession, AntigravityPromptError, ANTIGRAVITY_PERMISSION_KIND } from './AntigravityAcpSession.js'
export type {
  AntigravityAcpSessionOptions,
  AntigravityActivity,
  AntigravityConditionSnapshot,
  AntigravityMcpServer,
  AntigravityPermissionOption,
  AntigravityPermissionRequest,
  AntigravitySessionEvents,
} from './AntigravityAcpSession.js'
export { TurnAssembler } from './transcript/assembler.js'
export type { AntigravityRow, AntigravityRowRole, AntigravitySemanticEvent, AntigravityToolSnapshot } from './transcript/assembler.js'
export { AcpConnection, AcpError } from './acp/AcpConnection.js'
export { listAntigravityConversations, readAntigravityConversation } from './catalog.js'
export type { AntigravityConversationListing } from './catalog.js'
export { antigravityConversationExists, antigravityConversationFile, normalizeAntigravityCwd, resolveAntigravityCliDir } from './paths.js'
