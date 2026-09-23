// Which provider conditions mean "the agent is blocked on the user".
//
// WHY here and not only inside each provider's renderer condition policy: two
// owners need the same answer. The renderer policy uses it for attention badges
// and feed auto-follow; main's Agent Analytics recorder (#964) uses it to stop
// counting working time while an agent waits on a permission prompt or a question
// (docs/decomposition/agent-working-time.md §6 Q4). The policy modules cannot be
// loaded by the main-process program — they import the renderer capability
// registry, which pulls the renderer subtree — and a second hand-kept list in main
// would drift the first time a provider adds a prompt kind. src/shared/types is
// compiled by both the node and the web projects, so the list lives once, here.
//
// Membership rules (moved verbatim from the policies):
//   - Claude EXCLUDES claude.compaction (progress, not actionable) and
//     claude.slash-picker (a composer affordance, not an attention surface).
//   - Codex and OpenCode list every prompt kind they can raise.

export const CLAUDE_ATTENTION_CONDITION_KINDS = new Set<string>([
  'claude.trust-dialog',
  'claude.resume-prompt',
  'claude.permission-prompt',
  'claude.ask-user-question',
])

export const CODEX_ATTENTION_CONDITION_KINDS = new Set<string>([
  'codex.trust-dialog',
  'codex.approval',
])

export const OPENCODE_ATTENTION_CONDITION_KINDS = new Set<string>([
  'opencode.permission',
  'opencode.question',
])

// Grok was missing here (its policy kept a private copy), so Agent Analytics
// counted time blocked on a Grok permission prompt as working time. Now both
// read this one list.
export const GROK_ATTENTION_CONDITION_KINDS = new Set<string>([
  'grok.permission',
  'grok.question',
  'grok.plan-approval',
])

// Pi: a blocking extension dialog, or the project-trust selector at startup.
// Both are attention-only (answered in pi's own TUI) — see
// src/providers/pi/renderer/conditions/policy.ts.
export const PI_ATTENTION_CONDITION_KINDS = new Set<string>([
  'pi.dialog',
  'pi.trust',
])
