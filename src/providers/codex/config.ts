// Codex provider config — the shell's only import path into Codex code.

import type { ProviderConfig } from '../../shared/types/providerConfig'
import { CodexSession } from './runtime/codexSession'
import { listCodexSessions } from './runtime/sessionList'
import { getCodexSessionsDir } from './runtime/projectDir'
import { extractCodexAssistantInProgress } from './parsers/streamingScreen'

// For now, re-use the shared TileLeaf which already handles Codex.
// When we create a Codex-specific TileLeaf, this import changes.
import { TileLeaf } from '../../renderer/src/workspace/tile-tree/TileLeaf'

export const codexConfig: ProviderConfig = {
  id: 'codex',
  name: 'Codex',
  createSession: (opts) => new CodexSession(opts),
  listSessions: (cwd, limit) => listCodexSessions(cwd, limit),
  getProjectDir: async () => getCodexSessionsDir(),
  extractAssistantInProgress: extractCodexAssistantInProgress,
  TileLeaf: TileLeaf as ProviderConfig['TileLeaf'],
}
