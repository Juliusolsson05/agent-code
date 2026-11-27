// Where agy keeps its state, for the few things Agent Code needs to know
// without starting agy: whether a conversation still exists, and where the
// CLI is configured.
//
// Layout recorded against agy 1.5.15 (macOS):
//   ~/.gemini/antigravity-cli/settings.json
//   ~/.gemini/antigravity-cli/conversations/<sessionId>.db   (SQLite, private schema)
//   ~/.gemini/antigravity-cli/conversation_summaries.db       (SQLite, private schema)
//
// WHY Agent Code never reads those databases: their schema is undocumented
// and owned by a closed-source binary that updates itself in the background.
// Everything about a conversation's CONTENT comes from agy's own ACP server
// (session/load, session/list); these paths only answer "does it exist".

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function resolveAntigravityCliDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const base = env.GEMINI_CLI_HOME && env.GEMINI_CLI_HOME.length > 0 ? env.GEMINI_CLI_HOME : home
  return join(base, '.gemini', 'antigravity-cli')
}

export function antigravityConversationFile(sessionId: string, env?: Record<string, string | undefined>, home?: string): string {
  return join(resolveAntigravityCliDir(env, home), 'conversations', `${sessionId}.db`)
}

/** Does agy still hold this conversation? (Resume falls back to a new one if not.) */
export function antigravityConversationExists(sessionId: string, env?: Record<string, string | undefined>, home?: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(sessionId) && existsSync(antigravityConversationFile(sessionId, env, home))
}

/**
 * agy reports a session's cwd percent-encoded for sessions created over ACP
 * (`/Users/x/Application%20Support/…`) and plain for TUI sessions (recorded on
 * 1.5.15). Decode only when the result is still an absolute path, so a real
 * directory name containing '%' survives.
 */
export function normalizeAntigravityCwd(cwd: string): string {
  if (!cwd.includes('%')) return cwd
  try {
    const decoded = decodeURIComponent(cwd)
    return decoded.startsWith('/') ? decoded : cwd
  } catch {
    return cwd
  }
}
