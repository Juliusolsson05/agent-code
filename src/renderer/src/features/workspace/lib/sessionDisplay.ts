import { isAgentProviderKind } from '@shared/types/providerKind'
import type { SessionKind } from '@shared/types/providerKind'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
// Small display helpers shared by the workspace's search and
// activity modals (PromptSearchModal, AgentActivityModal).
//
// WHY this is scoped to those modal surfaces and not a generic
// "providerLabel" module: tile-tree pane headers use slightly
// different wording (full provider names, "Claude Code" vs "Claude")
// and a different glyph set, and pulling them through one shared
// formatter risks unifying surfaces that should diverge. Keep this
// strictly for list/row UIs that show a one-character provider
// marker and a path basename.

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
// agent providers (PromptSearchModal) can still pass the narrower
// 'claude' | 'codex' subset — TypeScript will accept it.
export function providerGlyph(kind: SessionKind): string {
  // Registry-derived for agent kinds (#394 phase 2c-2). The non-registry pane
  // kinds are listed EXPLICITLY rather than sharing one fallback: 'terminal' was
  // the only one when this was written, so `return '$'` doubled as "the terminal
  // glyph" and "the default". Adding 'extension-view' silently gave an extension
  // pane a shell prompt — the same widening this codebase hit at ~30 other sites.
  if (isAgentProviderKind(kind)) return getRendererProviderCapabilities(kind).glyph
  if (kind === 'extension-view') return '◈'
  return '$'
}
