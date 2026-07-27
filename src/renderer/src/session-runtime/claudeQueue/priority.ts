import { PRIORITY_LATER, PRIORITY_NEXT, type QueueMode, type QueuePriority } from './types'

// Deriving upstream's `QueuedCommand.priority` and `.mode` from logged content.
//
// THE LOAD-BEARING FACT: priority is set PER EMIT SITE, not per mode. The
// previous implementation mapped every `<task-notification>` to 'later', which
// is true for agent/workflow completions and FALSE for background-command
// completions — and that single row is the whole "background commands stay in
// notifications forever" bug. With a queue of
//   [Agent "X" finished (later), Background command "Y" completed (next)]
// Claude's mid-turn drain at threshold 'next' takes only the background item
// and logs one `remove`; scoring both 'later' ties, index 0 wins, and the AGENT
// item is dropped while the background one is stranded permanently.
//
// Provenance for every row is in testing/fixtures/queue-operations/catalog.md.
// The short version:
//   - `enqueue()` defaults to 'next'                    (messageQueueManager.ts:129)
//   - `enqueuePendingNotification()` defaults to 'later' (messageQueueManager.ts:143)
//   - LocalShellTask overrides to 'next' for background shells and the stall
//     watchdog. The source reads `feature('MONITOR_TOOL') ? 'next' : 'later'`;
//     the installed 2.1.220 binary resolves it to `priority:"next"`.
//
// WHY content sniffing rather than a field: the transcript record is
// `{ type, operation, timestamp, sessionId, content? }`. There is no priority,
// no mode, and no id. Content is the only signal that exists.

const TASK_NOTIFICATION_OPEN = '<task-notification>'

/** Upstream `BACKGROUND_BASH_SUMMARY_PREFIX` (LocalShellTask.tsx:23). */
const BACKGROUND_BASH_SUMMARY_PREFIX = 'Background command '

/** Monitor-kind completions, which exist only when MONITOR_TOOL is on. */
const MONITOR_SUMMARY_PREFIX = 'Monitor "'

function summaryOf(content: string): string | null {
  return /<summary>\s*([\s\S]*?)\s*<\/summary>/.exec(content)?.[1] ?? null
}

export function isTaskNotification(content: string): boolean {
  return content.trimStart().startsWith(TASK_NOTIFICATION_OPEN)
}

export function deriveMode(content: string): QueueMode {
  return isTaskNotification(content) ? 'task-notification' : 'prompt'
}

/**
 * Upstream `isSlashCommand` (messageQueueManager.ts:541). Slash commands are
 * excluded from the mid-turn attachment drain AND processed individually by
 * `processQueueIfReady`, so they are never part of a cohort — which makes this
 * an eligibility gate, not a cosmetic classification.
 */
export function isSlashCommand(content: string): boolean {
  return content.trim().startsWith('/')
}

export function derivePriority(content: string): QueuePriority {
  if (!isTaskNotification(content)) {
    // enqueue() default. `useScheduledTasks` and `processSlashCommand` do
    // enqueue prompts at 'later', but both are machine-generated and neither is
    // distinguishable from a typed prompt by content. Defaulting to 'next'
    // matches the overwhelmingly common case (a user prompt) and errs toward
    // treating an item as MORE eligible, which the identity pass can correct;
    // the opposite error strands it, which nothing corrects.
    return PRIORITY_NEXT
  }

  const summary = summaryOf(content)
  if (summary?.startsWith(BACKGROUND_BASH_SUMMARY_PREFIX)) return PRIORITY_NEXT
  if (summary?.startsWith(MONITOR_SUMMARY_PREFIX)) return PRIORITY_NEXT

  // The stall watchdog emits a notification with NO <status> tag, deliberately
  // (upstream comment: print.ts treats <status> as a terminal signal and would
  // falsely close the task). It is enqueued at 'next' unconditionally, so
  // statuslessness is a reliable discriminator rather than a guess.
  if (!/<status>/.test(content)) return PRIORITY_NEXT

  // Agent / remote-agent / workflow / framework / cancel-summary completions.
  return PRIORITY_LATER
}

/**
 * Correlation identity for a notification: 1045/1045 of them carry `<task-id>`
 * in the corpus, and `<tool-use-id>` backs it up. This is what makes the
 * identity pass proof rather than fuzzy text matching.
 */
export function notificationIdOf(content: string): string | null {
  const taskId = /<task-id>\s*([\s\S]*?)\s*<\/task-id>/.exec(content)?.[1]
  if (taskId) return taskId
  return /<tool-use-id>\s*([\s\S]*?)\s*<\/tool-use-id>/.exec(content)?.[1] ?? null
}

/**
 * Prompts have no id, so identity is their text. Normalized because the
 * enqueued value carries PTY control bytes (a trailing `\r`, bracketed-paste
 * remnants) that the committed entry does not — comparing raw dropped ~28% of
 * real deliveries in measurement, and every one of those misses was trailing
 * noise rather than a genuinely different prompt.
 */
export function normalizeForMatch(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * How much of a prompt must match. Long enough that two different prompts
 * cannot collide in practice, short enough to survive the trailing-byte
 * divergence above. Prompts shorter than this match in full.
 */
export const PROMPT_MATCH_PREFIX = 48
