// Claude provider config — the shell's only import path into Claude code.
//
// Wires up Claude's session factory, session lister, screen parser,
// and TileLeaf component. The shell mounts config.TileLeaf inside
// TileTree; everything else (slash picker, trust dialog, Claude-specific
// rows) lives inside that component and the shell never knows about it.

import type { ProviderConfig } from '../../shared/types/providerConfig'
import { ClaudeSession } from './runtime/claudeSession'
import { listSessionsForCwd } from './runtime/sessionList'
import { getProjectDirForCwd } from '../../shared/runtime/projectDir'
import { extractAssistantInProgress } from './parsers/streamingScreen'

// For now, re-use the shared TileLeaf which already handles Claude.
// When we create a Claude-specific TileLeaf, this import changes to
// point at ./renderer/TileLeaf instead.
import { TileLeaf } from '../../renderer/src/tiles/TileLeaf'

export const claudeConfig: ProviderConfig = {
  id: 'claude',
  name: 'Claude Code',
  createSession: (opts) => new ClaudeSession(opts),
  listSessions: listSessionsForCwd,
  getProjectDir: getProjectDirForCwd,
  extractAssistantInProgress,
  TileLeaf: TileLeaf as ProviderConfig['TileLeaf'],
}
