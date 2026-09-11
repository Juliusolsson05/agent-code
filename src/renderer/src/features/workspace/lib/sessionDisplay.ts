import { isAgentProviderKind } from '@shared/types/providerKind'
import type { SessionKind } from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
// Small display helpers shared by the conversation rows (ConversationRow)
// and the activity modal (AgentActivityModal).
//
// WHY this is scoped to those modal surfaces and not a generic
// "providerLabel" module: tile-tree pane headers use slightly
// different wording (full provider names, "Claude Code" vs "Claude")
// and a different glyph set, and pulling them through one shared
// formatter risks unifying surfaces that should diverge. Keep this
// strictly for list/row UIs that show a one-character provider
// marker and a path basename.

/** "1 agent" / "3 agents".
 *
 *  WHY it lives here rather than beside either caller: the bulk-switch modal
 *  and the bulk-switch ACTION both count the same agents in the same sentence
 *  ("Switch 3 agents to Claude" in the button, "Switched 3 agents to Claude" in
 *  the toast). Two copies of a pluralization rule is exactly the drift this
 *  module exists to prevent — a fix to one would have silently left the other
 *  saying "1 agents". */
export function pluralAgents(n: number): string {
  return `${n} agent${n === 1 ? '' : 's'}`
}

export function cwdBasename(cwd: string): string {
  if (!cwd) return ''
  // Trim trailing slashes so `/foo/bar/` doesn't return an empty
  // basename. Then split on '/' and take the last non-empty segment.
  const trimmed = cwd.replace(/\/+$/, '')
  const parts = trimmed.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? trimmed
}

// WHY this accepts 'terminal' even though most callers only pass
// claude/codex: AgentActivityModal renders terminal sessions in the
// same list, so widening the signature means the modal doesn't have
// to special-case its row renderer. Callers that only deal with
// agent providers (ConversationRow) can still pass the narrower
// 'claude' | 'codex' subset — TypeScript will accept it.
export function providerGlyph(kind: SessionKind): string {
  // Registry-derived for agent kinds (#394 phase 2c-2); terminal is
  // the only non-registry pane kind and keeps its literal.
  if (isAgentProviderKind(kind)) return getRendererProviderCapabilities(kind).glyph
  return '$'
}
