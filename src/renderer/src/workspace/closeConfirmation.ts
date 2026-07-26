import type { SessionId } from '@renderer/workspace/types'


// ---------------------------------------------------------------------------
// Close confirmation policy (governance plan, Phase 7).
//
// Confirmation is NOT a blanket modal before every close. Closing a pane is
// something people do dozens of times an hour, and a dialog on the common case
// would be worse than the risk it guards. The recorded product decision splits
// it three ways:
//
//   idle, single session   -> immediate, and Undo Close recovers it
//   running or streaming   -> confirm
//   cascade or multi-target-> confirm, naming the EXACT count and list
//
// WHY "it's undoable" only covers the first case: Undo Close restores the
// workspace entry, not the world. It cannot bring back live terminal scrollback,
// an unsent composer draft, or a half-finished cascade where some children died
// and others did not. So the cheap case stays cheap precisely because it IS the
// one undo actually covers.
//
// This module is deliberately PURE. It decides; it does not prompt, mutate, or
// know what a dialog looks like. That keeps the product decision reviewable in
// one place instead of being re-derived at each of the five close entry points
// (palette, keybinding, tab button, native menu, programmatic).
// ---------------------------------------------------------------------------

export type CloseTargetSnapshot = {
  sessionId: SessionId
  /** Display name for the confirmation list. */
  title: string
  /** The provider is mid-turn, or its stream is not idle. */
  live: boolean
}

export type CloseConfirmationRequest =
  | { required: false }
  | {
      required: true
      reason: 'running' | 'multi' | 'irreversible'
      /** Every session this close will end, expanded. */
      targets: readonly CloseTargetSnapshot[]
      /** One-line summary naming the exact count. */
      summary: string
    }

/** The count-and-liveness sentence, shared by the judged and forced paths so
 *  the two never describe the same set differently. */
export function summarizeCloseTargets(targets: readonly CloseTargetSnapshot[]): string {
  const live = targets.filter(target => target.live)
  if (targets.length === 1) {
    const only = targets[0]
    return only.live ? `${only.title} is still working.` : `This closes ${only.title}.`
  }
  const liveNote = live.length > 0 ? `, ${live.length} still working` : ''
  return `This closes ${targets.length} sessions${liveNote}.`
}

/**
 * Does this close need the user to confirm, and what should it say?
 *
 * `targets` must ALREADY be the expanded set — parent plus linked children plus
 * any detached sessions a tab close would take with it. Expansion happens at
 * the call site because only it knows the shape of what is being closed; this
 * function's job is to judge the expanded set, and passing it an unexpanded one
 * would silently downgrade a cascade to a single close.
 */
export function closeConfirmationFor(
  targets: readonly CloseTargetSnapshot[],
): CloseConfirmationRequest {
  if (targets.length === 0) return { required: false }

  if (targets.length === 1) {
    const only = targets[0]
    if (!only.live) {
      // The cheap, common case, and the only one Undo Close genuinely covers.
      return { required: false }
    }
    return {
      required: true,
      reason: 'running',
      targets,
      summary: `${summarizeCloseTargets(targets)} Close it anyway?`,
    }
  }

  // More than one session dies. Whether it is a cascade (a parent taking its
  // linked children) or a bulk selection, the user must see the COUNT — the
  // audit's finding was that a close expanding from one row to four looked
  // identical to closing one.
  // 'multi' regardless of liveness: the dialog distinguishes "one agent is
  // working" from "several things die", and the live count is carried in the
  // summary. The earlier split derived 'cascade' vs 'bulk' from liveness rather
  // than from origin, so the value was both wrong and unread.
  return {
    required: true,
    reason: 'multi',
    targets,
    summary: summarizeCloseTargets(targets),
  }
}

/**
 * Is a grant still valid against a freshly re-read target set?
 *
 * The audit's bulk-close finding: a preview the user approved can go stale
 * between confirmation and the kill — an agent finishes, a new one spawns, a
 * session moves project. Re-running the enumeration and comparing here is what
 * stops a stale grant authorizing work the user never saw.
 *
 * Compares by ID SET, not by count. Two sessions closing and two different ones
 * appearing keeps the count identical while changing every target, which is
 * exactly the case a count check would wave through.
 */
export function grantStillMatches(
  granted: readonly CloseTargetSnapshot[],
  current: readonly CloseTargetSnapshot[],
): boolean {
  if (granted.length !== current.length) return false
  const currentIds = new Set(current.map(target => target.sessionId))
  return granted.every(target => currentIds.has(target.sessionId))
}

export type CloseGateOutcome =
  | {
      ok: true
      /** The set the caller is authorized to close. */
      targets: readonly CloseTargetSnapshot[]
      /** Whether a dialog was actually shown — i.e. whether time passed. */
      prompted: boolean
    }
  | { ok: false; reason: 'declined' | 'changed' }

/**
 * The whole gate: enumerate, judge, ask, and RE-ENUMERATE before granting.
 *
 * WHY re-enumeration lives in here and not at the call sites: every close path
 * has an await in the middle of it — the dialog — and the workspace does not
 * hold still while the user reads. Agents finish, new ones spawn, a cascade
 * elsewhere removes a child. The pre-dialog snapshot every caller had already
 * captured was therefore a description of a workspace that no longer exists by
 * the time the answer arrives, and acting on it kills whatever now occupies
 * those ids.
 *
 * Each of the five close entry points had its own copy of "expand, ask,
 * proceed", and every copy proceeded from the stale snapshot. Folding the
 * re-check into the gate is the only version where a new close path cannot
 * forget it: there is no way to get a `true` out of this function without the
 * second enumeration having agreed.
 *
 * `enumerate` MUST read live state on every call — passing a captured array
 * defeats the entire mechanism.
 *
 * Note `prompted`. When nothing was asked, no time passed, and callers can skip
 * their own post-await revalidation instead of paying for a re-derivation on
 * the common idle-single close.
 */
export async function runCloseConfirmationGate(input: {
  enumerate: () => CloseTargetSnapshot[]
  ask: (
    request: Extract<CloseConfirmationRequest, { required: true }>,
  ) => Promise<boolean>
  /**
   * Ask even when the policy would not.
   *
   * The idle-single exemption is a statement about a HUMAN pressing ⌘W: they
   * aimed at a pane, they can see it, and Undo Close covers the mistake. None
   * of that transfers to a close a MODEL decided to make. There is no aim, the
   * user may not be looking, and "it's undoable" is doing far more work when
   * nobody knows it happened.
   *
   * `headline` names who is asking. A dialog that says "Close these sessions?"
   * when the user did not ask to close anything is not a confirmation, it is a
   * riddle.
   */
  force?: { headline: string }
}): Promise<CloseGateOutcome> {
  const granted = input.enumerate()
  if (granted.length === 0) return { ok: true, targets: granted, prompted: false }
  const judged = closeConfirmationFor(granted)
  const request: Extract<CloseConfirmationRequest, { required: true }> | null =
    input.force
      ? {
          required: true,
          reason: 'irreversible',
          targets: granted,
          summary: `${input.force.headline} ${summarizeCloseTargets(granted)}`,
        }
      : judged.required
        ? judged
        : null
  if (!request) return { ok: true, targets: granted, prompted: false }

  const confirmed = await input.ask(request)
  if (!confirmed) return { ok: false, reason: 'declined' }

  // The user approved a specific LIST. Re-derive it and insist on the same ids.
  // Refusing outright (rather than closing the intersection) is deliberate for
  // single-pane closes: there is one target, so "it changed" means the thing
  // they approved is not the thing that would die. Bulk flows that should
  // salvage the unchanged majority use `narrowGrantToCurrent` instead.
  const current = input.enumerate()
  if (!grantStillMatches(granted, current)) return { ok: false, reason: 'changed' }
  return { ok: true, targets: current, prompted: true }
}

/**
 * The subset of a grant that is still present, for a bulk flow that should
 * proceed with what survives rather than abandoning everything.
 *
 * Used by Close Old Agents: if two of twelve agents woke up between preview and
 * commit, killing the other ten is the useful behaviour — but the two that
 * changed must be DROPPED, never killed on the strength of the old preview.
 */
export function narrowGrantToCurrent(
  granted: readonly CloseTargetSnapshot[],
  current: readonly CloseTargetSnapshot[],
): CloseTargetSnapshot[] {
  const currentById = new Map(current.map(target => [target.sessionId, target]))
  return granted.flatMap(target => {
    const now = currentById.get(target.sessionId)
    if (!now) return []
    // A session that STARTED working since the preview is no longer covered by
    // the grant: the user approved closing an idle agent, not a busy one.
    if (now.live && !target.live) return []
    return [now]
  })
}

export type PartialCloseOutcome = {
  closed: SessionId[]
  failed: { sessionId: SessionId; error: unknown }[]
  /** Dropped because they changed between grant and commit. */
  skipped: SessionId[]
}

/** Human-readable result for a bulk close that did not fully succeed. */
export function describePartialClose(outcome: PartialCloseOutcome): string | null {
  if (outcome.failed.length === 0 && outcome.skipped.length === 0) return null
  const parts = [`Closed ${outcome.closed.length}`]
  if (outcome.failed.length > 0) parts.push(`${outcome.failed.length} failed`)
  if (outcome.skipped.length > 0) parts.push(`${outcome.skipped.length} skipped (changed)`)
  return `${parts.join(', ')}.`
}

// ---------------------------------------------------------------------------
// Target expansion.
//
// The policy above judges an EXPANDED set. Expansion is separate because
// getting it wrong is the actual danger: an unexpanded set silently downgrades
// a cascade to a single close, and the user confirms one thing while four die.
// ---------------------------------------------------------------------------

/** The slice of workspace state expansion needs. Narrowed so these functions
 *  stay pure and testable without constructing a whole store. */
export type CloseExpansionState = {
  sessions: Record<string, { title?: string; kind?: string; linkedParentId?: string } | undefined>
}

/** The slice of runtime state that decides "is this session live". Mirrors what
 *  CloseOldAgentsModal already uses, so preview and confirmation agree. */
export type CloseExpansionRuntimes = Record<
  string,
  { sessionStatus?: string; streamPhase?: string | null } | undefined
>

/** Exported so paths that judge ONE session (Kill Buried) use the same
 *  liveness rule as expansion and as the bulk preview. Three copies of
 *  "is this busy" is how a preview and a confirmation come to disagree. */
export function isSessionLiveForClose(
  runtimes: CloseExpansionRuntimes,
  sessionId: string,
): boolean {
  return isLive(runtimes, sessionId)
}

function isLive(runtimes: CloseExpansionRuntimes, sessionId: string): boolean {
  const runtime = runtimes[sessionId]
  if (!runtime) return false
  const running = runtime.sessionStatus === 'running'
  const streaming = runtime.streamPhase != null && runtime.streamPhase !== 'idle'
  return Boolean(running || streaming)
}

function snapshot(
  state: CloseExpansionState,
  runtimes: CloseExpansionRuntimes,
  sessionId: string,
): CloseTargetSnapshot {
  return {
    sessionId,
    title: state.sessions[sessionId]?.title ?? sessionId,
    live: isLive(runtimes, sessionId),
  }
}

/**
 * Every session that closing `rootId` will end: the root plus its linked
 * descendants, TRANSITIVELY.
 *
 * Transitive matters — a linked child can itself have linked children, and
 * stopping at one level would under-report the cascade in exactly the deep case
 * where the user most needs the count. The visited set guards against a
 * malformed parent cycle rather than trusting the data to be a clean tree.
 */
export function expandSessionCloseTargets(
  state: CloseExpansionState,
  runtimes: CloseExpansionRuntimes,
  rootId: string,
): CloseTargetSnapshot[] {
  const out: CloseTargetSnapshot[] = []
  const visited = new Set<string>()
  const queue = [rootId]

  while (queue.length > 0) {
    const id = queue.shift() as string
    if (visited.has(id)) continue
    visited.add(id)
    if (!state.sessions[id]) continue
    out.push(snapshot(state, runtimes, id))
    for (const [childId, meta] of Object.entries(state.sessions)) {
      if (meta?.linkedParentId === id) queue.push(childId)
    }
  }
  return out
}

/**
 * Every session a TAB close will end: each grid leaf expanded through its
 * linked descendants, plus the tab's detached Dispatch sessions.
 *
 * Detached sessions are the ones people forget. They have no tile in the tab
 * the user is looking at, so a tab close that silently takes six background
 * agents with it looks like closing an empty tab.
 */
export function expandTabCloseTargets(
  state: CloseExpansionState,
  runtimes: CloseExpansionRuntimes,
  gridSessionIds: readonly string[],
  detachedSessionIds: readonly string[],
): CloseTargetSnapshot[] {
  const seen = new Set<string>()
  const out: CloseTargetSnapshot[] = []
  for (const id of [...gridSessionIds, ...detachedSessionIds]) {
    for (const target of expandSessionCloseTargets(state, runtimes, id)) {
      if (seen.has(target.sessionId)) continue
      seen.add(target.sessionId)
      out.push(target)
    }
  }
  return out
}
