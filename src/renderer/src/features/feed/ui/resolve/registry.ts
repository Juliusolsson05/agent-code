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

// 'local_shell' is the rollout-synthesized COMMITTED name for the live
// 'local_shell_call' kind — both are the command family.
const COMMAND_TOOLS = new Set(['Bash', 'bash', 'exec_command', 'local_shell_call', 'local_shell', 'write_stdin'])
const READ_TOOLS = new Set(['Read', 'FileRead', 'Grep', 'Glob', 'LS'])
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'apply_patch'])
const WRITE_TOOLS = new Set(['Write'])
const TODO_TOOLS = new Set(['TodoWrite', 'todowrite'])
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch', 'web_search', 'web_search_call', 'tool_search', 'tool_search_call'])
const IMAGE_GEN_TOOLS = new Set(['image_generation', 'image_generation_call'])

/** Tool names a provider's LEGACY dispatch still claims with bespoke
 *  parsing the family cards don't replicate. OpenCode's `read` result
 *  is <path>/<content> tag soup parsed by OpencodeReadResult; its
 *  `todowrite` reuses TodoRow. Family routing + result suppression
 *  must skip these or the tag soup paints raw (the exact regression
 *  the GenericToolCard cutover briefly introduced for opencode reads).
 *  Scope note: OpenCode gets no dedicated cards this rewrite (spec §1.2)
 *  — this carve-out IS its integration. */
export function isLegacyProviderClaimed(
  provider: AgentProviderKind,
  toolName: string,
): boolean {
  // todowrite left this list when TodoCard landed (it takes a label,
  // so the cross-provider reuse survives); `read` stays until someone
  // teaches a card to parse OpenCode's <path>/<content> envelope.
  return provider === 'opencode' && toolName === 'read'
}

/** Modern Codex `exec` (unified script tool): the family depends on
 *  what the SCRIPT does, not the tool name — tools.apply_patch inside
 *  the script is a file edit, tools.exec_command/write_stdin are
 *  commands. Codex's own TUI renders the intent ("Edited x (+7 -3)");
 *  routing by name alone painted every edit as a raw-script card (the
 *  2026-07-12 debug-bundle regression). */
export function isUnifiedExecTool(toolName: string): boolean {
  return toolName === 'exec'
}

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
  if (IMAGE_GEN_TOOLS.has(toolName)) return 'image-gen'
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
  'file-read',
  'todo',
  'web',
  'image-gen',
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
  'file-read',
  'todo',
  'web',
  'image-gen',
] satisfies ArtifactFamily[])
