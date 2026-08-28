import {
  derivePriority,
  deriveMode,
  isSlashCommand,
  isTaskNotification,
  normalizeForMatch,
  notificationIdOf,
  PROMPT_MATCH_PREFIX,
} from './priority'
import type {
  ClaudeQueueState,
  CommittedUserEntry,
  PendingItem,
  QueueDecision,
  QueueDecisionReason,
  QueueOperationRecord,
  QueuedCommandObservation,
} from './types'

// Reconciling Claude's provider-owned message queue from a lossy operation log.
//
// See docs/decomposition/claude-queue-reconciliation.md. The one-paragraph
// version of WHY this module exists at all:
//
// Claude logs `{ operation, timestamp, content? }`. Every enqueue and 77.4% of
// recorded removes carry content; older removes and every dequeue omit it. So
// some departures are self-identifying while legacy ones need the durable
// evidence that follows. The previous implementation ignored remove content
// and guessed, by scoring pending content into a
// priority bucket and removing the lowest — and because nothing ever repairs
// Claude's queue (the idle-clear invariant is capability-gated OFF for Claude,
// and queuedMessages resets only on session exit) every wrong guess was
// permanent for the life of the session. That is why the reported symptom was
// "forever" rather than "briefly wrong".
//
// The fix is not a better guess. It is using the evidence that actually exists,
// which differs per operation — measured from the recorded corpus:
//
//   dequeue -> delivered as a turn input, lands as a committed `user` entry
//              carrying the content in the dominant recorded shape
//   remove  -> exact record content in newer Claude; otherwise a durable
//              attachment/queued_command with UUID + prompt follows
//
// So: `dequeue` is settled by IDENTITY (task-id for notifications, normalized
// text for prompts) and only falls back to inference when no entry claims it.
// Legacy `remove` records wait for the queued-command attachment and only use
// the upstream cohort rule at a later operation/idle boundary. Observed and
// inferred removals have distinct reasons so debug output never upgrades a
// fallback into proof.
//
// Both paths emit a QueueDecision. The decision record IS the diagnosis; there
// is deliberately no second "why is this still queued" derivation that could
// disagree with what the strip shows (rendering principle P4).

/**
 * Committed entries to wait through before giving up on identity for a pending
 * `dequeue`. In the corpus the delivery is the very NEXT entry every time, so
 * two is already generous; the bound exists so a `dequeue` whose delivery never
 * lands cannot hold the debt open forever and silently freeze the strip.
 */
const SETTLE_AFTER_ENTRIES = 2

/** Bounded, so a pasted document does not end up inside a decision record. */
const PREVIEW_CHARS = 120

function previewOf(content: string): string {
  const summary = /<summary>\s*([\s\S]*?)\s*<\/summary>/.exec(content)?.[1]
  const base = summary ?? content
  const flat = base.replace(/\s+/g, ' ').trim()
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1)}…`
}

export function createClaudeQueueState(): ClaudeQueueState {
  return { pending: [], decisions: [], debt: null, removeDebt: null, nextSeq: 0 }
}

function decide(
  item: PendingItem,
  reason: QueueDecisionReason,
  evidence: string[],
  at: string | null,
): QueueDecision {
  return { reason, preview: previewOf(item.content), evidence, at }
}

/**
 * Upstream's cohort order: `(priority, insertion)`. `dequeue` picks the
 * best-priority item and drains its whole mode cohort; the mid-turn `remove`
 * drain takes everything at or above a priority threshold. Both reduce to
 * "take from the front of this ordering", which is why one comparator serves
 * both and why taking exactly N reproduces the threshold shift for free:
 * a run longer than the 'next' cohort spills into 'later' precisely when
 * upstream would have raised its own threshold (the `sleepRan` branch).
 */
function cohortOrder(a: PendingItem, b: PendingItem): number {
  return a.priority - b.priority || a.seq - b.seq
}

/**
 * Eligibility is PER OPERATION, because upstream's two drains disagree about
 * slash commands and getting this wrong strands them forever.
 *
 * - `remove` (query.ts:1642, the mid-turn attachment drain) explicitly skips
 *   them: `if (isSlashCommand(cmd)) return false`. A slash command must be
 *   routed through processSlashCommand after the turn, never sent to the model
 *   as attachment text.
 * - `dequeue` (queueProcessor.processQueueIfReady) does the opposite — it
 *   dequeues a slash command INDIVIDUALLY, ahead of the batch path:
 *   `if (isSlashCommand(next) || next.mode === 'bash') { dequeue(isMainThread) }`.
 *
 * Treating them as globally ineligible meant they could leave by neither path.
 * A recorded session ended holding twelve such items — eleven identical `/loop`
 * prompts and a `/model` — which the strip would render as "12 queued" forever.
 * Their delivery is also not observable (a slash command commits as its
 * expansion, not its literal text), so the cohort fallback is the only way they
 * can ever retire.
 */
function isCohortEligible(item: PendingItem, op: 'dequeue' | 'remove'): boolean {
  return op === 'dequeue' || !item.isSlashCommand
}

/** Take `count` items in cohort order. Returns the removed items, in that order. */
function takeCohort(
  pending: PendingItem[],
  count: number,
  op: 'dequeue' | 'remove',
): PendingItem[] {
  const eligible = pending.filter(i => isCohortEligible(i, op)).sort(cohortOrder)
  return eligible.slice(0, Math.max(0, count))
}

function without(pending: PendingItem[], removed: readonly PendingItem[]): PendingItem[] {
  if (removed.length === 0) return pending
  const drop = new Set(removed.map(i => i.seq))
  return pending.filter(i => !drop.has(i.seq))
}

/**
 * Does this committed entry carry the identity of that pending item?
 *
 * Notifications match on a correlation id (present on 1144/1144 in the
 * current corpus).
 * Prompts have no id, so they match on a normalized prefix — see
 * `normalizeForMatch` for why raw comparison loses ~28% of real deliveries.
 */
function entryClaims(item: PendingItem, entry: CommittedUserEntry): boolean {
  if (item.mode === 'task-notification') {
    // Require the entry to BE a notification, not merely to mention the id.
    // A subagent's task-id also appears in Task tool blocks and in its own
    // transcript rows; matching those would count a non-delivery as proof and
    // remove a still-pending item — the exact failure this module exists to
    // stop, just with a friendlier-looking cause.
    if (!isTaskNotification(entry.text)) return false
    const id = notificationIdOf(item.content)
    return id !== null && entry.text.includes(id)
  }
  const needle = normalizeForMatch(item.content)
  if (needle.length === 0) return false
  const hay = normalizeForMatch(entry.text)
  return hay.includes(needle.slice(0, PROMPT_MATCH_PREFIX))
}

/**
 * Resolve which pending item a remove carrier names.
 *
 * WHY this is a two-pass resolve and not a single `find`: notification identity
 * falls back to a correlation id, and the recorded corpus proves that id is NOT
 * unique. In divergence-stranded-background-commands.json, 2 of 126 enqueued
 * task ids carry two DIFFERENT bodies — upstream reuses the id when it
 * reconciles a background shell from a previous session, so the queue can hold
 * both "...was stopped" and "No completion record was found..." under one id.
 *
 * A plain `find` returns whichever twin was enqueued first. When a carrier named
 * the SECOND exactly, that retired the first using the second's evidence and
 * stranded the one that actually departed — the precise wrong-item failure this
 * module exists to end, wearing a convincing-looking cause.
 *
 * Exact normalized text is the stronger evidence, so it is tried first. The id
 * pass stays as a fallback because it is what survives upstream reformatting of
 * a notification body — but it applies ONLY when exactly one pending item
 * carries the id. With two twins and no exact match, the id cannot say which
 * one left, and returning the first by array order would mislabel a coin flip
 * as `consumed-observed`, which this module's header forbids ("debug output
 * never upgrades a fallback into proof") and which strands the item that
 * actually departed. Declining leaves both visible with the debt open, so the
 * next cohort settlement retires one as an honest `consumed-inferred` — the
 * same conservative direction applyRemove takes when its exact target is
 * absent.
 *
 * Prompts are unaffected throughout: their branch in removeCarrierClaims
 * already required exact text equality, so pass 1 reproduces it and pass 2 can
 * only ever agree.
 */
function resolveRemoveCarrierTarget(
  pending: readonly PendingItem[],
  observation: Pick<QueuedCommandObservation, 'mode' | 'text'>,
): PendingItem | undefined {
  const needle = normalizeForMatch(observation.text)
  if (needle.length > 0) {
    const exact = pending.find(
      item => item.mode === observation.mode && normalizeForMatch(item.content) === needle,
    )
    if (exact) return exact
  }
  // Ambiguity is decided by COUNT, not by taking the first: two candidates mean
  // the carrier's id is not identifying, so no removal is provable here.
  const byId = pending.filter(item => removeCarrierClaims(item, observation))
  return byId.length === 1 ? byId[0] : undefined
}

/**
 * Exact identity for a remove carrier.
 *
 * WHY this is stricter than dequeue matching: dequeue's committed user row can
 * wrap the prompt and therefore needs prefix containment. Both remove.content
 * and queued-command.prompt are queue-native carriers. Treating a mere prefix
 * as exact here would let two similar queued prompts remove one another.
 */
function removeCarrierClaims(
  item: PendingItem,
  observation: Pick<QueuedCommandObservation, 'mode' | 'text'>,
): boolean {
  if (item.mode !== observation.mode) return false
  if (item.mode === 'task-notification') {
    const itemId = notificationIdOf(item.content)
    const observedId = notificationIdOf(observation.text)
    return itemId !== null && observedId !== null && itemId === observedId
  }
  const itemText = normalizeForMatch(item.content)
  return itemText.length > 0 && itemText === normalizeForMatch(observation.text)
}

function settleDebtByCohort(state: ClaudeQueueState): ClaudeQueueState {
  const debt = state.debt
  if (debt === null || debt.count <= 0) {
    return debt === null ? state : { ...state, debt: null }
  }
  const removed = takeCohort(state.pending, debt.count, 'dequeue')
  if (removed.length === 0) return { ...state, debt: null }
  return {
    ...state,
    pending: without(state.pending, removed),
    decisions: [
      ...state.decisions,
      ...removed.map(i => decide(i, 'delivered-inferred', [], debt.at)),
    ],
    debt: null,
  }
}

/** Find one fallback victim without sorting or allocating candidate arrays. */
function removeFallbackVictim(pending: readonly PendingItem[]): PendingItem | undefined {
  let best: PendingItem | undefined
  let notification: PendingItem | undefined
  for (const item of pending) {
    if (!isCohortEligible(item, 'remove')) continue
    if (!best || cohortOrder(item, best) < 0) best = item
    if (
      item.mode === 'task-notification' &&
      (!notification || cohortOrder(item, notification) < 0)
    ) {
      notification = item
    }
  }
  // Content-free remove has two upstream callers with conflicting rules.
  // Preserve user work in the ambiguous case; the rationale is expanded at
  // applyRemove where the debt is created.
  return best?.mode === 'prompt' && notification ? notification : best
}

function settleRemoveDebtByCohort(state: ClaudeQueueState): ClaudeQueueState {
  const debt = state.removeDebt
  if (debt === null || debt.count <= 0) {
    return debt === null ? state : { ...state, removeDebt: null }
  }

  let pending = state.pending
  const decisions: QueueDecision[] = []
  for (let remaining = debt.count; remaining > 0; remaining -= 1) {
    const victim = removeFallbackVictim(pending)
    if (!victim) break
    pending = without(pending, [victim])
    decisions.push(decide(victim, 'consumed-inferred', [], debt.at))
  }
  return {
    ...state,
    pending,
    decisions: decisions.length > 0 ? [...state.decisions, ...decisions] : state.decisions,
    removeDebt: null,
  }
}

function applyEnqueue(state: ClaudeQueueState, op: QueueOperationRecord): ClaudeQueueState {
  const content = op.content
  if (typeof content !== 'string') return state
  const timestamp = op.timestamp ?? ''

  // Idempotence guard, carried over from the previous implementation: the live
  // burst channel can redeliver the same record, and a duplicated pending item
  // would make every subsequent departure count off by one.
  const already = state.pending.some(q => q.timestamp === timestamp && q.content === content)
  if (already) return state

  const item: PendingItem = {
    content,
    timestamp,
    mode: deriveMode(content),
    priority: derivePriority(content),
    seq: state.nextSeq,
    isSlashCommand: isSlashCommand(content),
    stale: false,
  }
  return { ...state, pending: [...state.pending, item], nextSeq: state.nextSeq + 1 }
}

function applyRemove(state: ClaudeQueueState, op: QueueOperationRecord): ClaudeQueueState {
  // `remove` has TWO upstream callers with DIFFERENT selection rules, and
  // getting this wrong reproduced both halves of the original bug:
  //
  //   query.ts:1642   mid-turn attachment drain — selects by PRIORITY
  //                   threshold across prompts AND notifications.
  //   REPL.tsx:2532   Ctrl+B backgrounding — `removeByFilter(cmd => cmd.mode
  //                   === 'task-notification')`, i.e. selects by MODE, and
  //                   never touches a queued prompt.
  //
  // Modelling only the first meant that on Ctrl+B, with a queue of
  // [prompt(next), Agent finished(later)], we removed the PROMPT (better
  // priority) while upstream removed the NOTIFICATION — deleting a prompt that
  // is still queued in Claude and stranding the notification forever. That is
  // the exact pair of symptoms this module exists to end, reintroduced by the
  // fix.
  //
  // A legacy content-free record cannot tell us which caller fired. The two
  // rules only disagree when the best-priority item is a PROMPT and a
  // notification is also queued, and in that situation the candidates are:
  //   attachment-drain  -> the prompt
  //   Ctrl+B            -> the oldest notification
  // We resolve toward the NOTIFICATION, because the asymmetry of being wrong is
  // not symmetric. Wrongly removing a notification leaves a prompt visible and
  // the identity pass can still retire it on its `dequeue`. Wrongly removing a
  // prompt deletes the user's pending work from the strip with no way back —
  // the irreversible direction. Prompts are additionally the case where
  // evidence usually arrives anyway (87% observable on `dequeue`), so deferring
  // on them costs little.
  if (typeof op.content === 'string') {
    const content = op.content
    const mode = deriveMode(content)
    const victim = resolveRemoveCarrierTarget(state.pending, { mode, text: content })

    // Exact remove content and older dequeue debt account for DIFFERENT
    // departures. Settling the inferred debt first can guess away the very
    // item this record names; the exact lookup then no-ops and some unrelated
    // item survives permanently. A recorded 16-enqueue / 3-dequeue /
    // 13-exact-remove run does exactly that, including duplicate task ids that
    // make count- or identity-set-based repair impossible after the fact.
    //
    // Preserve the stronger carrier first and leave the debt as a bounded
    // count for its own later identity/idle settlement. If this exact target
    // is absent (partial bootstrap or redelivery), return the ORIGINAL state:
    // settling debt here would remove a neighbor by inference while the caller
    // believes this carrier was a conservative no-op. There is deliberately no
    // settle-then-retry scan — settlement only removes pending items, so it
    // cannot expose a match and would spend heap/CPU to weaken the invariant.
    // A content-bearing remove is its own proof. If redelivery or a partial
    // bootstrap means its target is absent, doing nothing is safer than
    // converting failed exact evidence into permission to remove a neighbor.
    if (!victim) return state
    return {
      ...state,
      pending: without(state.pending, [victim]),
      decisions: [
        ...state.decisions,
        decide(victim, 'consumed-observed', ['queue-operation content'], op.timestamp ?? null),
      ],
    }
  }

  // Content-free legacy records carry no competing exact evidence. The
  // earlier dequeue completed first, so settle its bounded debt before opening
  // a second inference debt for this remove.
  const settled = settleDebtByCohort(state)

  // Older Claude versions logged no content. Do not guess immediately: the
  // durable queued-command attachment is recorded a few lines later and can
  // cross watcher bursts. Debt retains only a count and is capped by eligible
  // pending membership, so waiting does not duplicate or unbound prompt data.
  const eligibleCount = settled.pending.reduce(
    (count, item) => count + (isCohortEligible(item, 'remove') ? 1 : 0),
    0,
  )
  const priorCount = settled.removeDebt?.count ?? 0
  if (eligibleCount <= priorCount) return settled
  return {
    ...settled,
    removeDebt: {
      count: priorCount + 1,
      at: settled.removeDebt?.at ?? op.timestamp ?? null,
    },
  }
}

function applyDequeue(state: ClaudeQueueState, op: QueueOperationRecord): ClaudeQueueState {
  if (state.pending.length === 0) return state
  // ACCUMULATE, never settle here. Upstream logs one record per item inside a
  // single batch drain, so consecutive `dequeue` records are usually ONE
  // operation whose N deliveries all land afterwards. Settling the previous
  // debt on each record would throw away the identity evidence that is still
  // in flight and fall back to inference for cases where proof arrives one
  // line later — reintroducing exactly the guesswork this module removes.
  return {
    ...state,
    debt: {
      count: (state.debt?.count ?? 0) + 1,
      entriesSeen: 0,
      at: state.debt?.at ?? op.timestamp ?? null,
    },
  }
}

function applyPopAll(state: ClaudeQueueState, op: QueueOperationRecord): ClaudeQueueState {
  // `popAll` logs its content, so it needs no inference at all — match and
  // remove exactly what was popped. Upstream pulls only EDITABLE commands into
  // the composer and deliberately leaves task-notifications queued, so a
  // content match is also the correct scope.
  //
  // WHY this receives the RAW state and settles no debt, exactly as
  // applyRemove does: an open remove debt accounts for a DIFFERENT departure,
  // and settling it first picks its victim by FIFO cohort order — which can be
  // the very item this record names. The exact lookup then misses, returns
  // early, and some unrelated item survives permanently while the debt has
  // been spent on the wrong one. This path previously ran
  // settleRemoveDebtByCohort(state) before matching and did exactly that; with
  // a single queued item and one open debt it consumed that item by inference
  // on behalf of a carrier naming something else entirely.
  //
  // On a miss, return the ORIGINAL state. A content-bearing carrier is its own
  // proof: if its target is absent (redelivery, partial bootstrap), doing
  // nothing is safer than converting failed exact evidence into permission to
  // remove a neighbour by inference.
  const content = op.content
  if (typeof content !== 'string') return state
  const needle = normalizeForMatch(content)
  if (needle.length === 0) return state
  const target = state.pending.find(
    i => i.mode === 'prompt' && normalizeForMatch(i.content) === needle,
  )
  if (!target) return state
  return {
    ...state,
    pending: without(state.pending, [target]),
    decisions: [
      ...state.decisions,
      decide(target, 'popped-to-composer', ['popAll content'], op.timestamp ?? null),
    ],
  }
}

/**
 * Apply one `queue-operation` record.
 *
 * Returns the SAME state object by reference when nothing changed — the D11
 * contract. This is a correctness property, not an optimization: `QueueStrip`
 * and the pane above it memoize on this array, and cloning on a no-op shipped
 * render churn twice before.
 */
export function applyQueueOperation(
  state: ClaudeQueueState,
  op: QueueOperationRecord,
): ClaudeQueueState {
  switch (op.operation) {
    case 'enqueue':
      return applyEnqueue(settleRemoveDebtByCohort(state), op)
    case 'dequeue':
      return applyDequeue(settleRemoveDebtByCohort(state), op)
    case 'remove':
      return applyRemove(state, op)
    case 'popAll':
      // Raw state, NOT settleRemoveDebtByCohort(state) — see applyPopAll.
      // `remove` and `popAll` are the two carriers that log their own content,
      // so both must apply that exact evidence before any inference runs.
      return applyPopAll(state, op)
    default:
      // An unknown operation must not be guessed at. Upstream's vocabulary is
      // enqueue/dequeue/remove/popAll today; if a fifth appears, doing nothing
      // leaves an item visible (diagnosable) rather than removing the wrong one
      // (silent and permanent).
      return state
  }
}

/**
 * Feed one durable queued-command carrier into legacy remove attribution.
 *
 * The caller projects Claude grammar through the provider adapter; this pure
 * layer sees only mode/text/UUID. Matching scans the bounded pending queue once
 * and retains none of the observation after the call.
 */
export function applyQueuedCommandObservation(
  state: ClaudeQueueState,
  observation: QueuedCommandObservation,
): ClaudeQueueState {
  const debt = state.removeDebt
  if (debt === null || debt.count <= 0) return state
  const claimed = resolveRemoveCarrierTarget(state.pending, observation)
  if (!claimed) return state
  const remaining = debt.count - 1
  return {
    ...state,
    pending: without(state.pending, [claimed]),
    decisions: [
      ...state.decisions,
      decide(
        claimed,
        'consumed-observed',
        [observation.uuid ?? 'queued-command attachment'],
        debt.at,
      ),
    ],
    removeDebt: remaining > 0 ? { ...debt, count: remaining } : null,
  }
}

/**
 * Feed a committed `user` entry in. This is the identity pass: it is what turns
 * a `dequeue` from a guess into proof.
 */
export function applyCommittedUserEntry(
  state: ClaudeQueueState,
  entry: CommittedUserEntry,
): ClaudeQueueState {
  if (state.debt === null || state.debt.count <= 0) return state

  const claimed = state.pending.find(i => entryClaims(i, entry))
  if (claimed) {
    const remaining = state.debt.count - 1
    return {
      ...state,
      pending: without(state.pending, [claimed]),
      decisions: [
        ...state.decisions,
        decide(claimed, 'delivered-observed', [entry.uuid ?? 'committed-entry'], state.debt.at),
      ],
      debt: remaining > 0 ? { ...state.debt, count: remaining, entriesSeen: 0 } : null,
    }
  }

  const entriesSeen = state.debt.entriesSeen + 1
  if (entriesSeen < SETTLE_AFTER_ENTRIES) {
    return { ...state, debt: { ...state.debt, entriesSeen } }
  }
  return settleDebtByCohort(state)
}

/**
 * Idle sweep. Marks items that no departure ever attributed.
 *
 * WHY marking and not deleting: the residue is ~3% of notifications and its
 * dominant cause is `clearCommandQueue()` (ctrl+x ctrl+k), which empties
 * Claude's queue and logs NOTHING — no evidence exists, so no attribution is
 * possible even in principle. Deleting on a heuristic is the irreversible
 * failure class (#159/#290); leaving it silently pending is a false claim that
 * work is still queued. Marking is the only option that is neither.
 *
 * The caller supplies idleness because lifecycle state lives outside this pure
 * module; see the call site in useIpcSubscriptions.
 */
export function markStaleWhenIdle(state: ClaudeQueueState, idle: boolean): ClaudeQueueState {
  if (!idle) return state
  const settled = settleRemoveDebtByCohort(settleDebtByCohort(state))
  // Only items that have already survived at least one departure are suspect.
  // A queue that has simply never been drained is not stale, it is waiting.
  if (settled.decisions.length === 0) return settled
  if (settled.pending.every(i => i.stale)) return settled
  return {
    ...settled,
    pending: settled.pending.map(i => (i.stale ? i : { ...i, stale: true })),
    decisions: [
      ...settled.decisions,
      ...settled.pending.filter(i => !i.stale).map(i => decide(i, 'stale-unattributed', [], null)),
    ],
  }
}
