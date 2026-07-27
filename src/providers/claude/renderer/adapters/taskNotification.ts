import type { Entry } from '@shared/types/transcript'
import type { ProviderTaskNotification } from '@shared/types/providerConfig'

// Claude <task-notification> parsing — the background-task result carrier
// (subagents AND background Bash; residue plan P2b).
//
// The XML arrives as a synthetic USER entry (no permissionMode, text
// starts '<') that legacy painted as a raw user bubble — the 2026-06-29
// "rendered like a retard" / "agent output buried" bundles. One parser
// serves every Claude-aware consumer: durable-entry dispatch, the Feed join
// map feeding ClaudeAgentRow, the QueueStrip chip, and the
// ledger collector's carve-out.
//
// Parsing is tag-scoped regex, NOT an XML parser, on purpose: the payload
// is machine-written with a fixed tag set, and <result> bodies contain
// arbitrary markdown INCLUDING angle brackets — a real parser would need
// entity handling the producer never applies. Last-match wins for
// <result> via greedy scan so nested closing-tag lookalikes inside the
// body don't truncate it.

export type TaskNotification = ProviderTaskNotification

const OPEN_TAG = '<task-notification>'

function boundDisplayScalar(value: string | null, maxChars: number): string | null {
  if (value === null || value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 1)}…`
}

function tag(text: string, name: string): string | null {
  const m = new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`).exec(text)
  return m ? m[1] : null
}

/** Greedy variant for bodies that may contain markup themselves. */
function tagGreedy(text: string, name: string): string | null {
  const m = new RegExp(`<${name}>\\s*([\\s\\S]*)\\s*</${name}>`).exec(text)
  return m ? m[1] : null
}

export function taskNotificationTextOf(entry: Entry): string | null {
  if (entry.type !== 'user') return null
  const msg = (entry as { message?: { role?: string; content?: unknown } }).message
  if (msg?.role !== 'user') return null
  const content = msg.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? (content.find(
            b => (b as { type?: string })?.type === 'text',
          ) as { text?: string } | undefined)?.text ?? null
        : null
  if (typeof text !== 'string') return null
  return text.trimStart().startsWith(OPEN_TAG) ? text : null
}

export function parseTaskNotification(text: string): TaskNotification | null {
  if (!text.trimStart().startsWith(OPEN_TAG)) return null
  return {
    // WHY correlation identity is the sole unbounded scalar: toolUseId is a
    // map key and truncating it would join a completion to the wrong parent.
    // Every presentation-only scalar is bounded here because both the joined
    // Agent headline and standalone notification render it synchronously.
    taskId: boundDisplayScalar(tag(text, 'task-id'), 240),
    toolUseId: tag(text, 'tool-use-id'),
    status: boundDisplayScalar(tag(text, 'status'), 120),
    summary: boundDisplayScalar(tag(text, 'summary'), 500),
    result: tagGreedy(text, 'result'),
    outputFile: boundDisplayScalar(tag(text, 'output-file'), 2_048),
    usage: boundDisplayScalar(tag(text, 'usage'), 240),
  }
}

export function taskNotificationFromEntry(entry: Entry): TaskNotification | null {
  const text = taskNotificationTextOf(entry)
  return text ? parseTaskNotification(text) : null
}

export function collectClaudeTaskNotifications(
  entries: readonly Entry[],
): ReadonlyMap<string, ProviderTaskNotification> {
  const notifications = new Map<string, ProviderTaskNotification>()
  for (const entry of entries) {
    const notification = taskNotificationFromEntry(entry)
    if (notification?.toolUseId) notifications.set(notification.toolUseId, notification)
  }
  return notifications
}

export function taskNotificationStatusKind(
  n: TaskNotification,
): 'done' | 'error' | 'attention' | 'other' {
  const s = (n.status ?? '').toLowerCase()
  if (s.includes('fail') || s.includes('error')) return 'error'
  if (s.includes('complete') || s.includes('done') || s.includes('success')) return 'done'

  // A notification with NO <status> at all is the stall watchdog
  // (LocalShellTask.startStallWatchdog): a background command that stopped
  // producing output and whose tail looks like an interactive prompt. Upstream
  // omits <status> deliberately — print.ts treats it as a terminal signal and
  // an unknown value would falsely close the task for SDK consumers.
  //
  // WHY this needs its own kind: callers rendered `kind === 'error' ? '✗' : '✓'`,
  // so a command STUCK waiting for input showed a green check — the single most
  // misleading state this surface can paint, because the whole point of the
  // watchdog is to tell you something needs a human. 'other' could not be
  // reused for it: 'other' also covers a status we simply do not recognise,
  // which is not a call for attention.
  if (n.status === null) return 'attention'

  return 'other'
}
