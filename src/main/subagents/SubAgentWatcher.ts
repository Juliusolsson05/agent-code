import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubAgentState } from '@preload/api/types.js'
import { buildSubAgentState, type SubAgentMeta } from './subagentState.js'

// One poller per session, watching <sessionDir>/subagents/.
//
// WHY polling instead of fs.watch: the dir often does not exist until the
// first subagent spawns (so fs.watch would throw at start), macOS fs.watch is
// flaky for append-heavy files, and the cost here is trivial — a readdir + a
// tail-read of whatever grew. We track a byte offset per file so each tick only
// parses appended lines, never re-reads the whole transcript. Emits only when
// something actually changed (dirty flag) to avoid spamming IPC.

const POLL_MS = 600
const MAX_RETAINED_ENTRIES_PER_AGENT = 500

type ParentResult = (toolUseId: string) => { done: boolean; error: boolean }

type RawEntry = Parameters<typeof buildSubAgentState>[3][number]

export class SubAgentWatcher {
  private timer: NodeJS.Timeout | null = null
  private offsets = new Map<string, number>() // agentId -> byte offset consumed
  private partialByAgent = new Map<string, string>()
  private entriesByAgent = new Map<string, RawEntry[]>()
  private metaByAgent = new Map<string, SubAgentMeta>()
  private dirty = false
  private stopped = false

  constructor(
    private readonly subagentsDir: string,
    private readonly parentResult: ParentResult,
    private readonly onChange: (subAgents: Record<string, SubAgentState>) => void,
  ) {}

  start(): void {
    // Kick once immediately so an already-populated dir surfaces fast, then
    // poll. The first tick also covers the common "dir created moments later"
    // case — readdir simply throws and we retry next tick.
    void this.tick()
    this.timer = setInterval(() => void this.tick(), POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.offsets.clear()
    this.partialByAgent.clear()
    this.entriesByAgent.clear()
    this.metaByAgent.clear()
  }

  /** Force a re-emit (e.g. the parent transcript just produced a tool_result
   *  that flips a subagent running→done). */
  refresh(): void {
    this.dirty = true
    void this.tick()
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    try {
      await this.rescan()
    } catch {
      // Dir not created yet (no subagents spawned) — nothing to do; retry next
      // tick. Any other transient FS error is also safe to retry.
      return
    }
    if (this.dirty) {
      this.dirty = false
      this.emit()
    }
  }

  private async rescan(): Promise<void> {
    const files = await readdir(this.subagentsDir)
    for (const f of files) {
      if (f.endsWith('.meta.json')) {
        const agentId = f.slice('agent-'.length, -'.meta.json'.length)
        if (this.metaByAgent.has(agentId)) continue // meta is written once
        try {
          const raw = await readFile(join(this.subagentsDir, f), 'utf8')
          this.metaByAgent.set(agentId, JSON.parse(raw) as SubAgentMeta)
          this.dirty = true
        } catch {
          /* partial write; retry next tick */
        }
      } else if (f.endsWith('.jsonl') && f.startsWith('agent-')) {
        const agentId = f.slice('agent-'.length, -'.jsonl'.length)
        await this.readAppended(agentId, join(this.subagentsDir, f))
      }
    }
  }

  private async readAppended(agentId: string, path: string): Promise<void> {
    const { size } = await stat(path)
    const from = this.offsets.get(agentId) ?? 0
    if (size <= from) return

    // WHY stream the appended byte range instead of `readFile(path)`:
    //
    // PR #277's design and comments promised offset-based tailing, but the
    // implementation still read the entire growing subagent transcript on
    // every poll and sliced the buffer afterwards. That is read amplification
    // in exactly the path that appears during large Task fan-outs: one busy
    // subagent makes every 600ms tick allocate its whole JSONL file again.
    // Reading only `[from, size)` keeps the watcher proportional to new bytes,
    // which is the actual invariant future code should preserve.
    const appended = await readRange(path, from, size)
    const text = (this.partialByAgent.get(agentId) ?? '') + appended
    const lastNl = text.lastIndexOf('\n')
    if (lastNl < 0) {
      this.partialByAgent.set(agentId, text)
      this.offsets.set(agentId, size)
      return
    }

    const complete = text.slice(0, lastNl)
    this.partialByAgent.set(agentId, text.slice(lastNl + 1))
    this.offsets.set(agentId, size)
    const arr = this.entriesByAgent.get(agentId) ?? []
    for (const line of complete.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        arr.push(JSON.parse(t) as RawEntry)
      } catch {
        /* skip a malformed line */
      }
    }
    if (arr.length > MAX_RETAINED_ENTRIES_PER_AGENT) {
      // WHY cap parsed entries even though the renderer timeline is already
      // capped in buildSubAgentState:
      //
      // The IPC payload cap only protects the renderer. Keeping every parsed
      // RawEntry here still makes main-process heap grow with long-running
      // subagents and duplicates large tool-result strings in memory. The
      // mini-feed is a liveness/status affordance, not a full transcript
      // archive; the durable source remains the on-disk JSONL if a future UI
      // wants deep drill-in. Retaining a generous tail preserves current
      // activity and recent tool context while bounding this watcher.
      arr.splice(0, arr.length - MAX_RETAINED_ENTRIES_PER_AGENT)
    }
    this.entriesByAgent.set(agentId, arr)
    this.dirty = true
  }

  private emit(): void {
    const out: Record<string, SubAgentState> = {}
    for (const [agentId, meta] of this.metaByAgent) {
      const toolUseId = meta.toolUseId
      if (!toolUseId) continue // can't link without it — skip (design spec §8)
      const entries = this.entriesByAgent.get(agentId) ?? []
      const { done, error } = this.parentResult(toolUseId)
      out[toolUseId] = buildSubAgentState(
        toolUseId,
        agentId,
        meta,
        entries,
        done,
        error,
      )
    }
    this.onChange(out)
  }
}

function readRange(path: string, from: number, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    const stream = createReadStream(path, {
      start: from,
      end: size - 1,
      encoding: 'utf8',
    })
    stream.on('data', chunk => {
      out += chunk
    })
    stream.on('error', reject)
    stream.on('end', () => resolve(out))
  })
}
