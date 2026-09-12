// A TLDR is a glance, not another transcript. A character bound is enforceable
// across languages; counting periods would reject abbreviations and still let
// a model submit one enormous sentence. The writing guidance supplies the
// one-or-two-sentence constraint, while this bound protects the actual surface.
export const TLDR_MAX_CHARACTERS = 400
export const TLDR_SKILL_NAME = 'agent-code-tldr'
export const TLDR_SKILL_DESCRIPTION = 'Maintain this agent’s concise status after substantial work or discussion when Agent Code TLDR MCP is available. Skip minor clarifications that leave task status unchanged.'
export const TLDR_INSTRUCTIONS = `When TLDR MCP is available in this session, use tldr_update to maintain your one current TLDR. As soon as you understand the goal of a new substantive task, set your TLDR to that goal before starting the work. Then update after meaningful milestones and before your final response to a substantive work or discussion turn. Each update replaces the previous entry.

Write one or two short sentences, at most ${TLDR_MAX_CHARACTERS} characters. Lead with any decision or action the user needs to take; otherwise state the verified outcome and the next step. Describe the current task state, not a chronological activity log. Name a relevant PR when useful. Claim completion, passing tests, or a merge only after verifying it.

Skip minor questions, acknowledgements, and clarifications when they leave the task status unchanged. Judge meaning, not word count: a short instruction such as “merge it” changes the task and needs an update after execution. Substantial discussions and newly identified choices or blockers also need updates.

Examples:
- The requested work is complete. PR #123 is merged into main.
- Your decision is needed: keep the existing API or replace it with the simpler version. I recommend keeping compatibility.
- The fix is implemented and tests pass. I’m reviewing the changes before opening the PR.

Only update your own summary through the available TLDR tool. If this session has no TLDR MCP capability, this skill is inactive: do not try to create files, contact another session, or invent a substitute tool. A TLDR is status reporting, not permission to take additional actions.`

export type TldrRecord = {
  text: string
  updatedAt: string
  revision: number
}
export type TldrUpdate = { identity: string; record: TldrRecord }

// History exists to answer "how did this agent get here", which the single
// current record overwrites. A hundred entries covers a long working session at
// the milestone cadence the instructions ask for, while keeping each agent's
// file small enough to rewrite atomically on every update.
export const TLDR_HISTORY_LIMIT = 100
export type TldrHistoryEntry = { text: string; writtenAt: string; revision: number }

/** Whether this agent's provider turn hooks have reached Agent Code during this
 * app run. Enforcement is invisible when it works and silent when it does not,
 * so the peek uses this to say which one it is. `null` means never. */
export type TldrEnforcementStatus = { hookContactAt: string | null }

export function validTldrIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value)
}

export function normalizeTldrText(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error('TLDR must be plain text without control characters.')
  }
  const text = value.replace(/\s+/gu, ' ').trim()
  if (!text || [...text].length > TLDR_MAX_CHARACTERS) {
    throw new Error(`TLDR must contain 1–${TLDR_MAX_CHARACTERS} characters.`)
  }
  return text
}
