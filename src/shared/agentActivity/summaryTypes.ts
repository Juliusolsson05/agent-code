// The Agent Analytics contract (#964, docs/decomposition/agent-working-time.md
// Stages 5–6): what main computes and the window shows.
//
// Purpose, in the user's words: "me as a founder to see what I have spent time on,
// so that I can make sure I do not waste any of my time." So every figure answers
// "what did the time go to": projects are the user's tabs, each lists the
// repositories and worktrees it touched, and the agents that did the work with
// what they were called.
//
// WHY main computes the whole tree and the window only paints it: the summary
// joins recorded intervals, machine suspensions and the current workspace. Doing
// any of that in a window would give two windows two answers (multi-window state
// belongs to main), and would let presentation code arbitrate overlap and grouping
// rules — the distributed-reconciliation failure the decomposition isolates.
//
// All durations are milliseconds of WORKING time: machine suspensions are already
// subtracted (workingSeconds.ts is the shared rule).

export type AgentActivityRange = '24h' | '7d' | '30d' | 'all'

export type AgentCounts = {
  /** Agents the user started. */
  user: number
  /** Orchestration workers spawned by another agent. */
  orchestration: number
}

export type AgentActivityAgentRow = {
  /** Stable agent identity: the agent name id when names are on, else the
   *  session id. Reloads, provider switches and rewinds of one agent share it. */
  agentKey: string
  /** What the user would call it: the pane title, else its agent name, else the
   *  folder, as recorded while it worked. */
  label: string
  role: 'user' | 'orchestration'
  provider: string
  agentMs: number
}

export type AgentActivityWorktreeRow = {
  cwd: string
  /** Folder name of the worktree. */
  label: string
  agentMs: number
  agents: AgentCounts
}

export type AgentActivityRepositoryRow = {
  /** Main checkout path of the repository (worktrees folded in), or the working
   *  directory itself when it is not a git repository. */
  repoRoot: string
  label: string
  /** Summed across agents: three agents working one hour = 3 h. */
  agentMs: number
  /** Wall-clock union: the same hour = 1 h. */
  wallMs: number
  agents: AgentCounts
  worktrees: AgentActivityWorktreeRow[]
}

export type AgentActivityProjectRow = {
  /** Grouping key. Projects are tabs, grouped by tab title so a tab closed and
   *  reopened for the same folder, or merged into another, stays one project
   *  (decomposition §6 Q10 default). */
  projectKey: string
  title: string
  /** A tab with this title is open in some window right now. */
  open: boolean
  agentMs: number
  wallMs: number
  agents: AgentCounts
  repositories: AgentActivityRepositoryRow[]
  /** Agents in this project with what they were called, most working time
   *  first — the "what did the time go to" answer. */
  topAgents: AgentActivityAgentRow[]
}

export type AgentActivityDay = {
  /** Local calendar date, YYYY-MM-DD. */
  date: string
  agentMs: number
  wallMs: number
}

export type AgentActivitySummary = {
  range: AgentActivityRange
  /** Inclusive start and exclusive end of the range, wall-clock ms. */
  from: number
  to: number
  /** When the recorder first recorded anything, or null if it never has.
   *  History is forward-only (§6 Q7); the window says so instead of implying the
   *  user did nothing before this date. */
  recordingSince: number | null
  totals: {
    agentMs: number
    wallMs: number
    agents: AgentCounts
  }
  /** Most agent time first. */
  projects: AgentActivityProjectRow[]
  /** One entry per local day in the range that had any working time, oldest
   *  first. The all-time range lists every recorded day. */
  days: AgentActivityDay[]
}

/** renderer → main: `(range: AgentActivityRange) => AgentActivitySummary`. */
export const AGENT_ACTIVITY_SUMMARY_CHANNEL = 'agent-activity:summary'
