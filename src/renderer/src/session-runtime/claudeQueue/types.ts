// Claude provider-owned queue — reconciliation types.
//
// See docs/decomposition/claude-queue-reconciliation.md for the canonical
// explanation and testing/fixtures/queue-operations/catalog.md for the measured
// evidence behind every rule here.

/**
 * Claude's dequeue order. Lower wins; FIFO within a level.
 * Mirrors `PRIORITY_ORDER` in upstream `utils/messageQueueManager.ts`.
 *
 * We can never observe 'now' — nothing in the corpus produces it and the log
 * carries no priority field — but the constant is kept so the ordering
 * comparison reads the same as upstream's and a future sighting has a slot.
 */
export const PRIORITY_NOW = 0
export const PRIORITY_NEXT = 1
export const PRIORITY_LATER = 2

export type QueuePriority = typeof PRIORITY_NOW | typeof PRIORITY_NEXT | typeof PRIORITY_LATER

/**
 * Upstream `QueuedCommand.mode`, reduced to what is *derivable from logged
 * content*. `bash` is deliberately absent: Claude logs a bash-mode command as
 * its bare text, indistinguishable from a prompt, so claiming to detect it
 * would be a guess wearing a type. The practical cost is bounded — bash-mode
 * commands are excluded from the mid-turn attachment drain upstream, so
 * treating one as a prompt can only make us over-eager on a `remove`, never
 * under-eager, and the identity pass corrects it on the following `dequeue`.
 */
export type QueueMode = 'prompt' | 'task-notification'

/**
 * Why an item left the queue (or was marked). CLOSED ENUM.
 *
 * Every reason must have at least one fixture proving when it fires — the same
 * keystone rule `RenderReason` carries in the rendering pipeline, and for the
 * same reason: removing a queued item is a claim that work is no longer
 * pending, and a wrong claim here is invisible and permanent (nothing repairs
 * Claude's queue; see queueInvariants.ts). If you need a new reason, write the
 * fixture first.
 */
export type QueueDecisionReason =
  /** A committed `user` entry carried this item's identity. Proof, not inference. */
  | 'delivered-observed'
  /** A `dequeue` departed and no committed entry claimed it inside the settle window. */
  | 'delivered-inferred'
  /** `remove.content` or a durable queued-command attachment identified it. */
  | 'consumed-observed'
  /** A legacy content-free `remove` had no durable attachment before settlement. */
  | 'consumed-inferred'
  /** `popAll` pulled it back into the composer. Content is logged, so this is proof. */
  | 'popped-to-composer'
  /** Still held, but no departure has attributed it and the session went idle. */
  | 'stale-unattributed'

export type QueueDecision = {
  reason: QueueDecisionReason
  /** Bounded preview — enough to identify the row in a debug bundle, never the whole payload. */
  preview: string
  /** What the decision was made from. Empty for pure-inference reasons, by design. */
  evidence: string[]
  /** Producer clock from the op record when present; null when the op carried none. */
  at: string | null
}

export type PendingItem = {
  content: string
  timestamp: string
  mode: QueueMode
  priority: QueuePriority
  /**
   * Insertion order. Load-bearing: upstream is FIFO *within* a priority level,
   * and `timestamp` cannot substitute — two items enqueued in the same
   * millisecond would compare equal and the tie-break would silently become
   * array order, which is the class of accident that produced the original bug.
   */
  seq: number
  /**
   * Slash commands are excluded from the mid-turn attachment drain but NOT from
   * `dequeue` — upstream dequeues them individually. Eligibility is therefore
   * per-operation; treating it as global stranded them forever.
   */
  isSlashCommand: boolean
  /** Set by the idle sweep when no departure ever attributed this item. */
  stale: boolean
}

/**
 * A `dequeue` that has not yet been attributed to a committed entry.
 *
 * WHY debt instead of removing immediately: `dequeue` deliveries are 98.5%
 * observable as a committed `user` entry (measured, see catalog.md), but the
 * entry arrives AFTER the op — typically the very next line. Removing on the op
 * would throw away the identity that is about to arrive and fall back to
 * inference for a case where proof exists. So the op records a debt and the
 * following entries settle it by identity; only an unsettled remainder falls
 * back to the cohort rule.
 */
export type QueueDebt = {
  /** How many departures still need attributing. */
  count: number
  /** Committed entries seen since the debt was incurred, used to bound the wait. */
  entriesSeen: number
  at: string | null
}

/**
 * Legacy content-free `remove` records waiting for durable attachment proof.
 *
 * WHY this stores only a count: the pending queue already owns the strings.
 * Copying candidate content into debt would retain pasted documents twice and
 * make heap use proportional to queue churn rather than current queue size.
 * The count is capped by eligible pending items at creation and settles at the
 * next non-remove queue operation or idle boundary, so it cannot grow without
 * a corresponding bounded pending queue.
 */
export type QueueRemoveDebt = {
  count: number
  at: string | null
}

export type ClaudeQueueState = {
  pending: PendingItem[]
  /** Append-only within a session. The diagnosis IS this record (principle P4). */
  decisions: QueueDecision[]
  debt: QueueDebt | null
  removeDebt: QueueRemoveDebt | null
  nextSeq: number
}

export type QueueOperationRecord = {
  operation: string
  content?: string
  timestamp?: string
}

export type CommittedUserEntry = {
  uuid?: string
  text: string
}

/** Provider-neutral identity projected from Claude's durable attachment. */
export type QueuedCommandObservation = {
  uuid?: string
  mode: QueueMode
  text: string
}
