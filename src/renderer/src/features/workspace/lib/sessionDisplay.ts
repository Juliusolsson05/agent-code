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
export function providerGlyph(kind: 'claude' | 'codex' | 'terminal'): string {
  if (kind === 'claude') return '⏺'
  if (kind === 'codex') return '›'
  return '$'
}
