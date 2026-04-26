// Main-process provider registry — Node-only, imports session factories.
//
// sessionManager and IPC handlers import from HERE.

import type { MainProviderConfig } from '@shared/types/providerConfig'
import { ClaudeSession } from '@providers/claude/runtime/claudeSession'
import { listSessionsForCwd, getProjectDirForCwd } from 'claude-code-headless'
import { CodexSession } from '@providers/codex/runtime/codexSession'
import { listCodexSessions, getCodexSessionsDir } from 'codex-headless'

const claudeMain: MainProviderConfig = {
  id: 'claude',
  name: 'Claude Code',
  createSession: (opts) => new ClaudeSession(opts),
  listSessions: (cwd, limit) => listSessionsForCwd(cwd, { limit }),
  getProjectDir: getProjectDirForCwd,
}

const codexMain: MainProviderConfig = {
  id: 'codex',
  name: 'Codex',
  createSession: (opts) => new CodexSession(opts),
  // Pass cwd through so the resume picker only shows sessions
  // recorded in the user's current working directory. Without this
  // filter the codex picker silently returned every session globally
  // (Codex doesn't partition by cwd), which let the user pick a
  // session whose underlying rollout cwd != cc-shell's spawn cwd.
  // That mismatch triggers Codex's upstream `cwd_prompt` modal, which
  // cc-shell has no detector for — the modal then eats the user's
  // first bracketed-paste submission. See the matching change in
  // packages/codex-headless/src/transcript/SessionList.ts.
  listSessions: (cwd, limit) => listCodexSessions({ cwd, limit }),
  getProjectDir: async () => getCodexSessionsDir(),
}

const mainProviders: Record<string, MainProviderConfig> = {
  claude: claudeMain,
  codex: codexMain,
}

export function getMainProvider(id: string): MainProviderConfig {
  const p = mainProviders[id]
  if (!p) throw new Error(`Unknown provider: ${id}`)
  return p
}
