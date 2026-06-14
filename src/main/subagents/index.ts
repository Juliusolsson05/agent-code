import { basename, dirname, join } from 'node:path'
import type { JsonlEntry, SubAgentState } from '@preload/api/types.js'
import { SubAgentWatcher } from './SubAgentWatcher.js'

// Owns one SubAgentWatcher per active session and the parent-completion
// bookkeeping that flips a subagent running→done.
//
// WHY we drive everything off the main transcript's jsonl-entry stream rather
// than a providerSessionId accessor: the session doesn't expose its Claude
// session uuid directly, but every jsonl-entry carries the transcript `file`
// path — `<projectDir>/<providerSessionId>.jsonl` — and the subagents dir is
// its sibling `<projectDir>/<providerSessionId>/subagents/`. Deriving the dir
// from `file` sidesteps the "uuid known only after start" timing problem and
// works identically on resume.

type Emit = (
  sessionId: string,
  subAgents: Record<string, SubAgentState>,
) => void

type ParentStatus = 'done' | 'error'

function subagentsDirFromTranscript(file: string): string | null {
  if (!file.endsWith('.jsonl')) return null
  const providerSessionId = basename(file, '.jsonl')
  return join(dirname(file), providerSessionId, 'subagents')
}

export class SubAgentWatcherManager {
  private watchers = new Map<string, SubAgentWatcher>()
  // sessionId -> (parent Agent tool_use id -> terminal status)
  private completed = new Map<string, Map<string, ParentStatus>>()

  constructor(private readonly emit: Emit) {}

  /**
   * Feed every main-transcript entry here. We (a) ensure a watcher exists for
   * the session, deriving its subagents dir from the transcript path, and
   * (b) record any tool_result for an `Agent` tool_use so the matching
   * subagent flips to done/error.
   */
  observeParentEntry(sessionId: string, entry: JsonlEntry, file: string): void {
    this.ensure(sessionId, file)

    const message = (entry as { message?: { content?: unknown } }).message
    const content = message?.content
    if (!Array.isArray(content)) return
    let changed = false
    for (const b of content as Array<Record<string, unknown>>) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        const map = this.completed.get(sessionId) ?? new Map<string, ParentStatus>()
        const status: ParentStatus = b.is_error === true ? 'error' : 'done'
        if (map.get(b.tool_use_id) !== status) {
          map.set(b.tool_use_id, status)
          this.completed.set(sessionId, map)
          changed = true
        }
      }
    }
    // A parent tool_result landing won't grow the subagent file, so nudge the
    // watcher to re-emit with the new done/error status.
    if (changed) this.watchers.get(sessionId)?.refresh()
  }

  private ensure(sessionId: string, file: string): void {
    if (this.watchers.has(sessionId)) return
    const dir = subagentsDirFromTranscript(file)
    if (!dir) return
    const watcher = new SubAgentWatcher(
      dir,
      toolUseId => {
        const s = this.completed.get(sessionId)?.get(toolUseId)
        return { done: s === 'done' || s === 'error', error: s === 'error' }
      },
      subAgents => this.emit(sessionId, subAgents),
    )
    this.watchers.set(sessionId, watcher)
    watcher.start()
  }

  stop(sessionId: string): void {
    this.watchers.get(sessionId)?.stop()
    this.watchers.delete(sessionId)
    this.completed.delete(sessionId)
  }

  stopAll(): void {
    for (const w of this.watchers.values()) w.stop()
    this.watchers.clear()
    this.completed.clear()
  }
}
