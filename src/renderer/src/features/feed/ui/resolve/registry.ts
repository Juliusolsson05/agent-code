import type { AgentProviderKind } from '@shared/types/providerKind'

import type { ArtifactFamily } from '@renderer/features/feed/ui/artifacts/types'

// Family routing — the ONE table that says which card a tool renders
// through, for BOTH planes. The old system had this knowledge smeared
// across four places (committed Block.tsx interception order, the
// provider dispatch.tsx files, BlockRow.tsx's live if-ladder, and
// ToolResultRow's hardcoded Read/Grep branches) and they drifted.
//
// Routing is total: anything unrecognized is 'generic' — never hidden,
// never thrown. Provider-specific rows that are NOT plain family
// routing (git-intent interception, spawn tools, AskUserQuestion)
// keep their existing pre-routing interceptions in Block/BlockRow;
// this table is only consulted after those.

const COMMAND_TOOLS = new Set(['Bash', 'bash', 'exec_command', 'local_shell_call', 'write_stdin'])
const READ_TOOLS = new Set(['Read', 'FileRead', 'Grep', 'Glob', 'LS'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'apply_patch'])
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch', 'web_search', 'web_search_call', 'tool_search_call'])

export function routeFamily(
  _provider: AgentProviderKind,
  toolName: string,
): ArtifactFamily {
  if (COMMAND_TOOLS.has(toolName)) return 'command'
  // Phase-4/5 families route here as their cards land; routing a name
  // before its card exists would send it to a component that doesn't
  // render it, so entries are added task-by-task with the cards:
  //   READ_TOOLS → 'file-read', EDIT_TOOLS → 'file-edit',
  //   'Write'/'TodoWrite'/'todowrite' → 'file-write'/'todo',
  //   WEB_TOOLS → 'web', mcp__* → 'mcp'.
  void READ_TOOLS
  void EDIT_TOOLS
  void WEB_TOOLS
  return 'generic'
}
