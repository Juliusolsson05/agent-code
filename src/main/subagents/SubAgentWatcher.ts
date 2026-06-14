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

type ParentResult = (toolUseId: string) => { done: boolean; error: boolean }

type RawEntry = Parameters<typeof buildSubAgentState>[3][number]

export class SubAgentWatcher {
  private timer: NodeJS.Timeout | null = null
  private offsets = new Map<string, number>() // agentId -> byte offset consumed
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
    const buf = await readFile(path)
    const text = buf.subarray(from).toString('utf8')
    // Only consume complete lines; leave the trailing partial for next tick.
    const lastNl = text.lastIndexOf('\n')
    if (lastNl < 0) return
    const consumedBytes = Buffer.byteLength(text.slice(0, lastNl + 1))
    this.offsets.set(agentId, from + consumedBytes)
    const arr = this.entriesByAgent.get(agentId) ?? []
    for (const line of text.slice(0, lastNl).split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        arr.push(JSON.parse(t) as RawEntry)
      } catch {
        /* skip a malformed line */
      }
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
