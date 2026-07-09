import { parseTaskNotification } from '@renderer/session-runtime/taskNotification'
import type { QueuedMessage } from '@renderer/session-runtime/state'

// Reconstruction of Claude's PROVIDER-OWNED message queue from the
// `queue-operation` transcript records our renderer replays live in
// useIpcSubscriptions.
//
// WHY this file exists (2026-07-07 soak bundles
// debug-bundles/manual/2026-07-07T13-17-20-472-5b19529f "completed agents
// renders as queued" and .../2026-07-07T13-17-48-452-5b19529f "a queued
// prompt did not get shown in the feed"):
//
// Claude's real queue (vendor/claude-code-src/full/utils/messageQueueManager.ts)
// is a PRIORITY queue, not FIFO:
//   - `enqueue`  (user prompts / bash / orphaned-permission) → priority 'next' (1)
//   - `enqueuePendingNotification` (<task-notification>)     → priority 'later' (2)
//   - `dequeue`  removes the LOWEST priority NUMBER (now:0 > next:1 > later:2),
//                FIFO WITHIN a priority level.
// So a user prompt enqueued AFTER two completed-agent task-notifications is
// still delivered FIRST, because 'next' beats 'later'.
//
// Our old reconstruction dropped `queue.slice(1)` (the head, index 0) on every
// dequeue/remove op. That is only correct when the queue is homogeneous. The
// moment the queue holds a MIX of a 'later' task-notification and a 'next'
// user prompt, Claude dequeues the prompt (a non-head item) while our slice(1)
// dropped a task-notification instead. The reconstruction then permanently
// diverges from Claude's real queue — and because Claude's queue is
// provider-owned (shouldClearIdleQueuedMessages is capability-gated to SKIP
// Claude on purpose, see queueInvariants.ts), nothing else ever repairs it.
// The two visible failures both fall out of that single drift:
//   1. completed-agent task-notifications never leave the QueueStrip
//      ("completed agents render as queued"), because the dequeue that should
//      have removed them removed the head instead; and
//   2. the user's own queued prompt vanishes from the strip
//      ("queued prompt did not get shown"), because a head-drop removed it
//      when Claude actually dequeued a different item.
//
// The transcript record cannot carry the priority — Claude's `logOperation`
// only writes `{ operation, content? }`, and dequeue/remove log NO content at
// all (no identity). So we INFER priority from the enqueued content we DO
// have: a `<task-notification>` payload is 'later', everything else is 'next'.
// We cannot detect 'now' (interrupt-class) prompts, but user prompts default
// to 'next', which is the correct relative order against 'later'
// notifications — the only mix these bundles exercise.
//
// This helper reduces to the old drop-head behaviour for a single-priority
// queue (every item same priority → lowest index wins → slice(1)), so the
// common "N queued user prompts, no notifications" path is unchanged.

const PRIORITY_LATER = 2
const PRIORITY_NEXT = 1

function inferQueuePriority(content: string): number {
  // A parsed task-notification is Claude's 'later' bucket
  // (enqueuePendingNotification). Everything else — plain prompts, bash,
  // slash commands — rides the default 'next' bucket like `enqueue` uses.
  return parseTaskNotification(content) !== null ? PRIORITY_LATER : PRIORITY_NEXT
}

/**
 * Mirror one Claude `dequeue`/`remove` operation against our reconstructed
 * queue: remove the first (lowest-index) item whose inferred priority is the
 * minimum present, exactly as messageQueueManager.dequeue selects its victim.
 *
 * `remove` in Claude targets specific commands by object identity, which we
 * do not have. Priority order is our best available proxy for which item left
 * the real queue, and it is strictly better than the previous blind head-drop
 * (identical for a homogeneous queue, correct for the mixed case that caused
 * the 2026-07-07 soak bugs).
 */
export function applyClaudeQueueDequeue(queue: QueuedMessage[]): QueuedMessage[] {
  if (queue.length === 0) return queue
  let bestIdx = 0
  let bestPriority = Number.POSITIVE_INFINITY
  for (let i = 0; i < queue.length; i++) {
    const priority = inferQueuePriority(queue[i]!.content)
    if (priority < bestPriority) {
      bestPriority = priority
      bestIdx = i
    }
  }
  return [...queue.slice(0, bestIdx), ...queue.slice(bestIdx + 1)]
}
