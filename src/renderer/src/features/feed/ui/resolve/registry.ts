import type { AgentProviderKind } from '@shared/types/providerKind'

import type { ArtifactFamily } from '@renderer/features/feed/ui/artifacts/types'

// Family routing — the ONE table that says which card a tool renders
// through, for BOTH planes. The old system had this knowledge smeared
// across four places (committed Block.tsx interception order, the
// provider dispatch.tsx files, BlockRow.tsx's live if-ladder, and
// ToolResultRow's hardcoded Read/Grep branches) and they drifted.
//
// Routing is total: anything unrecognized is 'generic' — never hidden,
// never thrown. Provider-specific interceptions that are NOT plain
// family routing (git-intent widgets, spawn tools, AskUserQuestion)
// stay ahead of this table in Block/BlockRow.
//
// MIGRATION STATE (2026-07 RENDER rewrite, spec §8): families whose
// dedicated card has LANDED are listed in CARD_LANDED_FAMILIES; the
// rest still fall through to the legacy provider-dispatch path until
// their phase-4/5 task ships the card. Routing the name now but
// gating on landed-ness keeps this table the single source of truth
// while the migration is in flight — delete the gate when the last
// card lands.

const COMMAND_TOOLS = new Set(['Bash', 'bash', 'exec_command', 'local_shell_call', 'write_stdin'])
const READ_TOOLS = new Set(['Read', 'FileRead', 'Grep', 'Glob', 'LS'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'apply_patch'])
const WRITE_TOOLS = new Set(['Write'])
const TODO_TOOLS = new Set(['TodoWrite', 'todowrite'])
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch', 'web_search', 'web_search_call', 'tool_search_call'])

export function routeFamily(
  _provider: AgentProviderKind,
  toolName: string,
): ArtifactFamily {
  if (COMMAND_TOOLS.has(toolName)) return 'command'
  if (READ_TOOLS.has(toolName)) return 'file-read'
  if (EDIT_TOOLS.has(toolName)) return 'file-edit'
  if (WRITE_TOOLS.has(toolName)) return 'file-write'
  if (TODO_TOOLS.has(toolName)) return 'todo'
  if (WEB_TOOLS.has(toolName)) return 'web'
  if (toolName.startsWith('mcp__')) return 'mcp'
  return 'generic'
}

/** Families whose dedicated card exists. 'mcp' rides on
 *  GenericToolCard (the VM carries the server badge) until Task 19
 *  upgrades it. */
export const CARD_LANDED_FAMILIES: ReadonlySet<ArtifactFamily> = new Set([
  'command',
  'generic',
  'mcp',
  'file-edit',
  'file-write',
] satisfies ArtifactFamily[])

/** Families whose committed card CONSUMES the paired tool_result
 *  (renders output/exit inside the card) — the tool_result block must
 *  be suppressed for these or the output paints twice. MUST stay a
 *  subset of CARD_LANDED_FAMILIES: suppressing a result whose card
 *  hasn't landed is data loss (e.g. apply_patch error results are
 *  still rendered by CodexToolResultRow until the DiffCard task). */
export const RESULT_CONSUMING_FAMILIES: ReadonlySet<ArtifactFamily> = new Set([
  'command',
  'generic',
  'mcp',
  // DiffCard consumes edit results: success stubs vanish (the diff is
  // the story, ✓ is the confirmation), errors render inside the card —
  // including Codex patch failures' tinted unified_diffs.
  'file-edit',
  'file-write',
] satisfies ArtifactFamily[])
