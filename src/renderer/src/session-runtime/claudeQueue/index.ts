// Claude provider-owned queue reconciliation.
//
// SINGLE CONSUMER: useIpcSubscriptions. Nothing else may compute queue
// membership — the whole point of collecting it here is that the decision has
// exactly one home, with a recorded reason per departure. A component that
// filters or re-derives this list has recreated the distributed-ownership bug
// class described in docs/rendering/rendering-design-principles.md §1.
//
// Design + evidence: docs/decomposition/claude-queue-reconciliation.md
// Measured corpus:   testing/fixtures/queue-operations/catalog.md

export {
  applyCommittedUserEntry,
  applyQueuedCommandObservation,
  applyQueueOperation,
  createClaudeQueueState,
  markStaleWhenIdle,
} from './reconcile'
export { derivePriority, deriveMode, isTaskNotification, notificationIdOf } from './priority'
export {
  PRIORITY_LATER,
  PRIORITY_NEXT,
  PRIORITY_NOW,
  type ClaudeQueueState,
  type CommittedUserEntry,
  type PendingItem,
  type QueueDecision,
  type QueueDecisionReason,
  type QueueOperationRecord,
  type QueuedCommandObservation,
} from './types'
