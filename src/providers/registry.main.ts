// Main-process provider registry — Node-only, imports session factories.
//
// sessionManager and IPC handlers import from HERE.

import type { MainProviderConfig } from '../shared/types/providerConfig'
import { ClaudeSession } from './claude/runtime/claudeSession'
import { listSessionsForCwd } from './claude/runtime/sessionList'
import { getProjectDirForCwd } from '../shared/runtime/projectDir'
import { CodexSession } from './codex/runtime/codexSession'
import { listCodexSessions } from './codex/runtime/sessionList'
import { getCodexSessionsDir } from './codex/runtime/projectDir'

const claudeMain: MainProviderConfig = {
  id: 'claude',
  name: 'Claude Code',
  createSession: (opts) => new ClaudeSession(opts),
  listSessions: listSessionsForCwd,
  getProjectDir: getProjectDirForCwd,
}

const codexMain: MainProviderConfig = {
  id: 'codex',
  name: 'Codex',
  createSession: (opts) => new CodexSession(opts),
  listSessions: (cwd, limit) => listCodexSessions(cwd, limit),
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
