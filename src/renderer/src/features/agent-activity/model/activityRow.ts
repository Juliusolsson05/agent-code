import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { GoalLoopState } from '@shared/types/goalLoop'
import type { TldrRecord } from '@shared/types/tldr'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { sessionActivity } from '@renderer/session-runtime/activity'
import { tldrIdentityForSession } from '@renderer/features/tldr/identity'
import {
  conditionRequiresAttention,
  dispatchAttentionLabelFromConditions,
} from '@renderer/workspace/conditions/selectors'
import { buildVisibleDispatchRows } from '@renderer/workspace/dispatch/dispatchSelectors'
import { isLimitIdle } from '@renderer/workspace/hook/actions/providerSwitchCore'
import { commandTargetSessionIdForState } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { terminalProviderFailure } from '@renderer/workspace/orchestrationMcp'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'
import { cwdBasename, sessionDisplayTitle } from '@renderer/workspace/sessionDisplayTitle'
import type { SessionId, SessionKind, SessionMeta, WorkspaceState } from '@renderer/workspace/types'

// ---------------------------------------------------------------------------
// The Agent Activity row model (#1170, decomposition Stage 2).
//
// ONE pure function decides, for every agent in the window, which section it
// belongs to and why. The view renders what this returns and nothing else, and
// the bulk-close flow re-asks it at each kill boundary, which is why it must
// stay synchronous and read only its arguments (no IPC, no Date.now()).
//
// WHY a new model instead of extending the old modal's per-row `useMemo`: the
// old modal answered one question ("when was this pane last active") from
// `runtime.entries`, and had no attention signal at all. Every signal below
// already exists somewhere in the app — this module only REUSES the owners:
//
//   - live provider prompt   → conditionRequiresAttention (the same rule that
//                               marks a background pane unread)
//   - failed provider turn   → terminalProviderFailure (#1018, the rule an
//                               orchestrating parent is told)
//   - usage limit            → isLimitIdle (the provider-switch guard's rule,
//                               which knows limitHit never self-clears)
//   - goal loop              → the index chip's own "is this a request for
//                               attention" reading (blocked, or paused)
//   - last active            → sessionActivity (#915, the TLDR footer's rule)
//
// A second copy of any of these rules would drift from the surface the user
// compares it with, and a row that says "working" beside a Dispatch dot that
// says "idle" is worse than no row.
// ---------------------------------------------------------------------------

export type ActivitySection = 'needs-you' | 'working' | 'idle' | 'exited'

/** Render order of the sections. "Needs you" first: at 30+ agents it is the
 *  only question worth answering at a glance. */
export const ACTIVITY_SECTIONS: readonly ActivitySection[] = ['needs-you', 'working', 'idle', 'exited']

/**
 * Where the row's name came from. Shown to the user, because a folder name
 * like `agent-code` is not a name anybody chose, and three identical rows
 * reading `agent-code` looked like a bug when they were really "nobody named
 * these" (decomposition, section A correction).
 */
export type ActivityNameSource = 'title' | 'goal' | 'folder'

export type ActivityRow = {
  sessionId: SessionId
  kind: SessionKind
  terminal: boolean
  name: string
  nameSource: ActivityNameSource
  /**
   * The row's second line: the agent's own TLDR when it has one, otherwise
   * what the runtime says it is doing right now. Never a prompt fragment — the
   * owner's fleet showed a first prompt reads as a rambling paragraph.
   */
  detail: string | null
  section: ActivitySection
  /** Why the row is in `needs-you` (or `exited`), in plain words. */
  reason: string | null
  /**
   * The agent's full Goal, kept apart from `name` so the filter finds it even
   * when an explicit title wins the name (review of #1105: "Backend" with Goal
   * "Fix authentication" did not match "authentication").
   */
  goal: string | null
  project: string
  pinned: boolean
  /** On at least one lane. A session CAN occupy several (decomposition,
   *  correction 8); the view only needs to know whether it is parked. */
  onLane: boolean
  /** The agent commands would act on — the focused lane's occupant. */
  focused: boolean
  lastActiveAt: number | null
}

/**
 * The note/loop inputs, read over IPC by useFleetNotes. Kept as plain records
 * so a test can hand the model exactly what main would have returned.
 */
export type FleetNotes = {
  /** TLDR records by tldrIdentity. */
  tldrs: Record<string, TldrRecord>
  /** Goal records by tldrIdentity (Goal shares TLDR's identity, #936). */
  goals: Record<string, TldrRecord>
  /** Goal loops by sessionId — NOT tldrIdentity (decomposition, correction 3). */
  loops: Record<string, GoalLoopState>
}

export const EMPTY_FLEET_NOTES: FleetNotes = { tldrs: {}, goals: {}, loops: {} }

/**
 * The provider's attention labels, in words.
 *
 * WHY translate instead of showing ACTION/QUESTION: those labels are sized for
 * a 5-character Dispatch badge. Here the reason IS the row's content, and "why
 * does this agent need me" deserves a sentence the user does not have to
 * decode. An unknown label (a future provider's) still shows, as-is, rather
 * than being swallowed.
 */
const CONDITION_REASONS: Record<string, string> = {
  ACTION: 'Wants permission',
  QUESTION: 'Asked you a question',
  TRUST: 'Asks to trust this folder',
  RESUME: 'Asks how to resume',
  PLAN: 'Wants its plan approved',
  ERROR: 'Compaction failed',
}

/**
 * Why this agent needs the user right now, or null.
 *
 * ORDER is most-actionable first, because a row shows ONE reason: a live
 * permission prompt is blocking this second, a failed turn is blocking until
 * re-prompted, and a queued prompt is merely not moving.
 */
export function attentionReason(
  meta: SessionMeta,
  runtime: SessionRuntime | undefined,
  loop: GoalLoopState | undefined,
): string | null {
  const kind = meta.kind ?? DEFAULT_PROVIDER
  // Terminals have no provider: capability lookups throw for them
  // (decomposition, correction 4), and a shell asks nothing of the user.
  if (!isAgentProviderKind(kind) || !runtime) return null
  // Process failures BEFORE the exit check (review of #1105): a provider that
  // dies before it is input-ready gets `exited` from the exit handler first,
  // and the wake-failure path then adds `processStatus: 'failed'` and the
  // error on top. Checking exit first hid that failed start as an ordinary
  // exit — the orchestration lifecycle orders them the same way, failed first.
  if (runtime.processError) return `Error: ${runtime.processError}`
  if (runtime.processStatus === 'failed') return 'Failed to start'
  if (isSessionExited(runtime)) return null

  // `conditionRequiresAttention` is the unread rule, and it deliberately
  // leaves compaction out: a running or finished compaction is progress. A
  // FAILED one is not, and the provider policy labels only that phase
  // (`ERROR`), so the label is checked on its own (review of #1105 — the
  // first cut read the label only inside the attention branch, where a failed
  // compaction could never reach it).
  const label = dispatchAttentionLabelFromConditions(runtime.conditions)
  if (conditionRequiresAttention(runtime.conditions) || label === 'ERROR') {
    return label ? CONDITION_REASONS[label] ?? label : 'Waiting for you'
  }
  // `meta` is REQUIRED here even though the signature makes it optional:
  // without it no provider branch runs and the answer is always null
  // (decomposition, correction 6). Grok never reads failed at all
  // (correction 7) — its rows simply never land here, which is the honest
  // reading of "no evidence", not a claim that Grok never fails.
  const failure = terminalProviderFailure(runtime, meta)
  if (failure) return `Turn failed: ${firstLine(failure.message)}`
  if (isLimitIdle(runtime) && !isWorking(runtime)) return 'Hit a usage limit'
  if (runtime.promptDelivery.kind === 'failed-safe' || runtime.promptDelivery.kind === 'uncertain') {
    return 'Your prompt did not send'
  }
  if (loop?.phase === 'ended' && loop.endReason === 'blocked') return 'Goal loop is blocked on you'
  // A paused loop is waiting for a human decision whatever paused it — raise
  // the cap, look at the error, or resume — so every pause reason counts
  // (Unknown 3 decided yes). The reason is in the text because each one is a
  // different next action.
  if (loop?.phase === 'paused') return loop.pauseReason ? `Goal loop paused (${loop.pauseReason})` : 'Goal loop paused'
  // A queue that is not being drained: the agent is idle, so nothing will
  // pick the prompt up. While the agent works, a queue is normal. `stale`
  // (Claude's unattributable residue) is excluded: the strip already says it
  // is stale, and "your prompt is stuck" would be a false alarm about a
  // prompt the provider may have dropped on purpose.
  if (!isWorking(runtime) && runtime.queuedMessages.some(message => !message.stale)) {
    return 'Queued prompt is not being sent'
  }
  return null
}

/**
 * The same "is this agent busy" reading Dispatch's activity dot uses
 * (`dispatchActivity`: stream phase, then session status), plus the provider's
 * own `processActive`. Kept local rather than imported because the dot's
 * function also classifies `starting`, which is not a section here.
 */
function isWorking(runtime: SessionRuntime): boolean {
  return runtime.sessionStatus === 'running'
    || (runtime.streamPhase != null && runtime.streamPhase !== 'idle')
    || runtime.processActive === true
}

function firstLine(text: string): string {
  const line = text.split('\n').find(part => part.trim().length > 0) ?? text
  return line.trim()
}

/**
 * The row's name: explicit title → Goal → folder (owner decision 3).
 *
 * WHY Goal and not TLDR: a Goal says what the work is FOR and changes only
 * when the direction changes, which is what a name has to do. A TLDR changes
 * every turn, so a list named by TLDRs would reshuffle its own labels while
 * the user reads it. The TLDR is the second line instead.
 */
export function activityRowName(
  meta: SessionMeta,
  goal: TldrRecord | undefined,
): { name: string; source: ActivityNameSource } {
  const title = meta.title?.trim()
  if (title) return { name: title, source: 'title' }
  const goalText = goal?.text.trim()
  if (goalText) return { name: firstLine(goalText), source: 'goal' }
  return { name: cwdBasename(meta.cwd) || meta.cwd, source: 'folder' }
}

function sectionFor(
  meta: SessionMeta,
  runtime: SessionRuntime | undefined,
  reason: string | null,
): ActivitySection {
  if (reason) return 'needs-you'
  if (runtime && isSessionExited(runtime)) return 'exited'
  if (!runtime) return 'idle'
  // A shell is "working" while a foreground command runs — the only signal a
  // PTY has (#865), and the same one Close Old Agents and the old modal used.
  if ((meta.kind ?? DEFAULT_PROVIDER) === 'terminal') {
    return runtime.sessionStatus === 'running' ? 'working' : 'idle'
  }
  return isWorking(runtime) ? 'working' : 'idle'
}

function detailFor(
  kind: SessionKind,
  runtime: SessionRuntime | undefined,
  tldr: TldrRecord | undefined,
): string | null {
  const tldrText = tldr?.text.trim()
  if (tldrText) return tldrText
  if (!runtime) return 'Starting…'
  if (kind === 'terminal') return runtime.terminalForeground?.command ?? null
  // The provider's own status line ("Honking…") before the generic phase,
  // because it is the more specific of the two.
  return runtime.activityStatus?.trim() || (runtime.streamPhase !== 'idle' ? runtime.streamPhase : null)
}

/**
 * Every agent and terminal in the window, sectioned and ordered.
 *
 * The fleet is `buildVisibleDispatchRows` — the index's own enumeration — and
 * NOT the lanes. The old modal listed panes, so the parked pool sessions most
 * likely to be closable were the ones it could not show (decomposition,
 * finding 3). Pinned rows come out of the same selector, so nothing is
 * double-counted or dropped (correction 8).
 */
export function buildActivityRows(
  state: WorkspaceState,
  runtimes: Record<SessionId, SessionRuntime>,
  notes: FleetNotes,
): ActivityRow[] {
  const focusedId = commandTargetSessionIdForState(state)
  const onLane = new Set(state.stage.lanes.map(lane => lane.selectedSessionId).filter(Boolean))
  const pinned = new Set(state.pinnedSessionIds)
  const rows: ActivityRow[] = []

  for (const indexRow of buildVisibleDispatchRows(state)) {
    const meta = state.sessions[indexRow.sessionId]
    if (!meta) continue
    const kind = meta.kind ?? DEFAULT_PROVIDER
    const runtime = runtimes[indexRow.sessionId]
    const identity = tldrIdentityForSession(indexRow.sessionId, meta)
    const goal = identity ? notes.goals[identity] : undefined
    const tldr = identity ? notes.tldrs[identity] : undefined
    const reason = attentionReason(meta, runtime, notes.loops[indexRow.sessionId])
    const section = sectionFor(meta, runtime, reason)
    const terminal = kind === 'terminal'
    const { name, source } = terminal
      // A shell has no goal. Its name is the one its pane header shows: the
      // title, else the LIVE tmux folder (it follows `cd`), else the spawn
      // folder — sessionDisplayTitle, so the two can never disagree (#865).
      ? {
          name: sessionDisplayTitle(meta, runtime?.terminalForeground?.cwd),
          source: (meta.title?.trim() ? 'title' : 'folder') as ActivityNameSource,
        }
      : activityRowName(meta, goal)

    rows.push({
      sessionId: indexRow.sessionId,
      kind,
      terminal,
      name,
      nameSource: source,
      detail: detailFor(kind, runtime, tldr),
      section,
      reason: reason ?? (section === 'exited' ? 'Exited' : null),
      goal: goal?.text.trim() || null,
      project: indexRow.tabTitle,
      pinned: pinned.has(indexRow.sessionId),
      onLane: onLane.has(indexRow.sessionId),
      focused: focusedId === indexRow.sessionId,
      // A shell has no transcript or turn clock; its last foreground change
      // (a command started, finished, or the shell cd'd) is the only activity
      // it has — the rule Close Old Agents and the old modal both use.
      lastActiveAt: terminal
        ? runtime?.terminalForeground?.changedAt ?? null
        : sessionActivity(runtime).timestamp,
    })
  }

  return sortActivityRows(rows)
}

/**
 * Section order first. Inside a section:
 *   - needs-you and working: most recent first — the one that just changed is
 *     the one the user is about to look for;
 *   - idle and exited: OLDEST first — these sections exist for cleanup, and the
 *     agent idle for three days is the one to close (decomposition, D.3).
 * A row with no activity at all sorts as oldest. The session id breaks ties so
 * the order is stable across renders instead of depending on insertion order.
 */
export function sortActivityRows(rows: ActivityRow[]): ActivityRow[] {
  const rank = (section: ActivitySection) => ACTIVITY_SECTIONS.indexOf(section)
  return [...rows].sort((a, b) => {
    if (a.section !== b.section) return rank(a.section) - rank(b.section)
    const at = a.lastActiveAt ?? 0
    const bt = b.lastActiveAt ?? 0
    if (at !== bt) {
      const newestFirst = a.section === 'needs-you' || a.section === 'working'
      return newestFirst ? bt - at : at - bt
    }
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0
  })
}

/**
 * Type-to-filter. Matches the name, the Goal, the second line, the reason,
 * the project and the provider, because the user remembers an agent by whichever of those
 * they saw last. Every word must match somewhere (AND), so "codex review"
 * narrows instead of widening.
 */
export function filterActivityRows(rows: ActivityRow[], query: string): ActivityRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return rows
  return rows.filter(row => {
    const haystack = [row.name, row.goal, row.detail, row.reason, row.project, row.kind]
      .filter(Boolean)
      .join('\n')
      .toLowerCase()
    return words.every(word => haystack.includes(word))
  })
}
