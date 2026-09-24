// A TLDR is a glance, not another transcript. A character bound is enforceable
// across languages; counting periods would reject abbreviations and still let
// a model submit one enormous sentence. The writing guidance supplies the
// one-or-two-sentence constraint, while this bound protects the actual surface.
export const TLDR_MAX_CHARACTERS = 400
export const TLDR_SKILL_NAME = 'agent-code-tldr'
export const TLDR_SKILL_DESCRIPTION = 'Maintain this agent’s concise status after substantial work or discussion when Agent Code TLDR MCP is available. Skip minor clarifications that leave task status unchanged.'
export const TLDR_INSTRUCTIONS = `When TLDR MCP is available in this session, use tldr_update to maintain your one current TLDR. As soon as you understand a new substantive task, set your TLDR before starting the work. When goal_set is also available, record the goal there and keep the TLDR to status; otherwise the first TLDR states the goal. Then update after meaningful milestones and before your final response to a substantive work or discussion turn. Each update replaces the previous entry.

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

/** `label` names the capability in errors the agent reads: a Goal store shares
 * this normalizer, and "TLDR must contain…" would send the agent to fix the
 * wrong tool. */
export function normalizeTldrText(value: string, label = 'TLDR'): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be plain text without control characters.`)
  }
  const text = value.replace(/\s+/gu, ' ').trim()
  if (!text || [...text].length > TLDR_MAX_CHARACTERS) {
    throw new Error(`${label} must contain 1–${TLDR_MAX_CHARACTERS} characters.`)
  }
  return text
}

// ---------------------------------------------------------------------------
// Goal (#936)
//
// A TLDR says where an agent is; a goal says what its work is for. They are
// separate capabilities because they change at different rates: a status
// replaced at every milestone would overwrite a goal written into it, which is
// exactly what happened when the first TLDR was used to hold the goal.
// ---------------------------------------------------------------------------

export const GOAL_SKILL_NAME = 'agent-code-goal'
export const GOAL_SKILL_DESCRIPTION = 'Record this agent’s goal — what its work is for — when Agent Code Goal MCP is available. Set it when a new task is understood; update it only when the direction changes.'
export const GOAL_INSTRUCTIONS = `When Goal MCP is available in this session, use goal_set to record your goal: what your work is trying to achieve and why, in one plain sentence that a person switching between many agents can understand without reading the transcript. Set it as soon as you understand a new substantive task, before starting the work.

Update the goal only when what you are trying to achieve changes — the user redirects you, widens or narrows the scope, or asks for a different outcome. Never update it to report progress; progress belongs in the TLDR when TLDR MCP is available.

Describe the outcome, not the activity or a list of steps. Avoid issue and PR numbers unless the goal is meaningless without them, and then say in words what they are. At most ${TLDR_MAX_CHARACTERS} characters.

Examples:
- Make agent reloads and crash recovery go through one owner, so an agent is never lost or duplicated.
- Let users hold Cmd+G to see what each agent is for, alongside the existing TLDR status peek.

Only set your own goal through the available tool. If this session has no Goal MCP capability, this skill is inactive: do not create files, contact another session, or invent a substitute tool. A goal describes intent; it is not permission to take additional actions.`

/** TLDR and Goal share one conversation identity and one set of turn hooks, so
 * every decision about minting that identity or injecting those hooks asks
 * whether EITHER capability is on. A Goal-only agent must not be identity-less. */
export function hasReportingDomain(domains: readonly string[] | undefined): boolean {
  return Boolean(domains?.includes('tldr') || domains?.includes('goal'))
}

/** The built-in MCP domains that come with a product-managed skill. Listed in a
 * fixed order so every warning names the skills in the same order, whatever
 * order the pre-spawn reconcile reported them in. */
export const REPORTING_DOMAINS = ['tldr', 'goal'] as const
export type ReportingDomain = (typeof REPORTING_DOMAINS)[number]

/** Main → renderer broadcast: one or more product skills could not be prepared
 * for an agent that asked for them, and that agent was started without them
 * (#1133). App-wide by design: skill health is machine-wide, not per-pane. */
export const MANAGED_SKILLS_UNAVAILABLE_CHANNEL = 'managed-skills:unavailable'
export type ManagedSkillsUnavailableEvent = { skills: ReportingDomain[] }

/**
 * The user-facing text for a skipped product skill (#1133).
 *
 * WHY it names Settings › Agents › Custom Skills: TLDR and Goal show up there
 * as "Managed by TLDR/Goal MCP" rows with their health and target rows, which
 * is the only place the user can see WHY the skill is broken (a conflicting
 * file, recovery required, a failed deploy). The toast is only a pointer. It
 * has to say where to look, because both outages this replaced ended with
 * someone hunting for the cause.
 *
 * WHY it says the agents are running: the old behavior was "nothing starts",
 * and a warning that reads like the old failure would send the user off to
 * restart panes that are fine. The part that is really lost is the skill's
 * guidance. The MCP tool still carries its own server instructions.
 *
 * Kept pure and shared so the text is testable without a renderer, and so any
 * future surface (remote client, notices) says exactly the same thing.
 */
export function managedSkillsUnavailableMessage(skills: readonly ReportingDomain[]): string {
  const labels = REPORTING_DOMAINS
    .filter(domain => skills.includes(domain))
    .map(domain => (domain === 'tldr' ? 'TLDR' : 'Goal'))
  const subject = labels.length > 1 ? `${labels.join(' and ')} skills` : `${labels[0] ?? 'Managed'} skill`
  return `${subject} could not be prepared, so agents started without ${labels.length > 1 ? 'them' : 'it'}. Review Settings › Agents › Custom Skills.`
}

/**
 * Why a hold-to-peek gesture ended, as far as main can tell (#1066).
 *
 * `released` — the native watcher saw the key come up, or the hold ended for
 *   a reason that says nothing about the keyboard (blur, navigation, a helper
 *   or packaging failure). The overlay comes down.
 * `unobservable` — the watcher could not see the keyboard at all. It proves
 *   this by asking about Command, which is physically down whenever a watcher
 *   starts, so a negative answer is a fact about the API rather than about the
 *   user's fingers. Treating it as a release is what made the peek flash and
 *   vanish with no explanation on every freshly signed build.
 *
 * Lives in shared/ because three processes touch it: main decides it, preload
 * forwards it, the renderer renders it.
 */
export type HoldEndReason = 'released' | 'unobservable'
