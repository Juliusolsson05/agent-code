import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubAgentState } from '@preload/api/types.js'
import {
  accumulateSubAgentEntry,
  buildSubAgentStateFromAccumulator,
  createAccumulator,
  type SubAgentAccumulator,
  type SubAgentMeta,
} from './subagentState.js'
import { readRange } from './shared.js'

// One poller per session, watching <sessionDir>/subagents/.
//
// WHY polling instead of fs.watch: the dir often does not exist until the
// first subagent spawns (so fs.watch would throw at start), macOS fs.watch is
// flaky for append-heavy files, and the cost here is trivial — a readdir + a
// tail-read of whatever grew. We track a byte offset per file so each tick only
// parses appended lines, never re-reads the whole transcript. Emits only when
// something actually changed (dirty flag) to avoid spamming IPC.

const POLL_MS = 600

// #288 ROOT-CAUSE FIX: this watcher no longer retains raw entries at all.
//
// HISTORY (why the old code was the way it was, so future-you doesn't reinvent
// it): a dominator-tree heap analysis (scripts/analyze-heapsnapshot.mjs --owners)
// pinned live SubAgentWatcher instances as ~85% of a 227 MB main-process heap via
//   SubAgentWatcher.entriesByAgent (Map<agentId, RawEntry[]>)
//     → entry → message.content → huge string.
// We chased that with COUNT caps (PR #300: keep 500 entries) and then per-FIELD
// byte caps (PR #320/#321: clamp every string in each retained entry). Both only
// SHRANK the retained entries; they never questioned WHY we retained entries at
// all. The answer is: we didn't need to. The renderer only consumes the derived
// SubAgentState, not the raw transcript entries, so retaining entries existed
// solely to recompute a fold that can be maintained incrementally instead. By
// folding each line as it streams in (see accumulateSubAgentEntry in
// subagentState.ts) and dropping the entry, the O(transcript) retention
// disappears entirely — no count cap, no byte cap, no string pool, no
// truncation. The durable full transcript still lives on disk in
// agent-<id>.jsonl. This mirrors the Codex twin (codexSubagentState.ts, PR #317).
//
// What that deletes from THIS file: truncateEntryBodies + clampDeep + clampString
// (the #320/#321 byte-cap machinery) and the internEntryFields/makeStringPool
// usage — all of it existed solely to make the retained entries cheaper, and with
// nothing retained there is nothing to clamp or intern. internEntryFields itself
// stays in internEntry.ts (jsonlCoalescer + historyLoader still use it).

type ParentResult = (toolUseId: string) => { done: boolean; error: boolean }

// Keep the watcher coupled only to the accumulator's accepted RawEntry shape,
// not to a provider package type. The accumulator is intentionally permissive:
// odd partial entries should be ignored, never crash the watcher.
type RawEntry = Parameters<typeof accumulateSubAgentEntry>[1]

export class SubAgentWatcher {
  private timer: NodeJS.Timeout | null = null
  private offsets = new Map<string, number>() // agentId -> byte offset consumed
  private partialByAgent = new Map<string, string>()
  // #288 ROOT-CAUSE FIX: per-agent ACCUMULATOR instead of a retained entry array.
  // Each appended line is folded into its agent's accumulator (a few scalars + a
  // bounded ≤60 tool-call ring) and then dropped. Memory is O(open tool calls),
  // not O(transcript length) — which is what killed the heap before. emit() reads
  // the live accumulator each call so a late parentResult flip still re-renders.
  private accByAgent = new Map<string, SubAgentAccumulator>()
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
    // #288: drop the per-agent accumulators (each holds only scalars + a small
    // bounded ring, but a stopped watcher must release everything regardless).
    this.accByAgent.clear()
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
    // #288 ROOT-CAUSE FIX: fold each appended line into the agent's accumulator
    // and let the parsed entry die. There is deliberately NO retained array, NO
    // 500-cap splice, NO truncate, NO intern here — nothing entry-shaped survives
    // a loop iteration, so the multi-MB tool-result/Read bodies the dominator
    // tree pinned can never accumulate. accumulateSubAgentEntry runs the SAME
    // source-of-truth per-entry derivation; the entry is read-only and becomes
    // GC-eligible the instant the iteration ends.
    let acc = this.accByAgent.get(agentId)
    if (!acc) {
      acc = createAccumulator()
      this.accByAgent.set(agentId, acc)
    }
    for (const line of complete.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const parsed = JSON.parse(t) as RawEntry
        // accumulateSubAgentEntry is defensive (permissive shapes, no throws on a
        // partial/edge entry), matching the old builder's contract. A malformed
        // line that slips past JSON.parse still can't take down this loop.
        accumulateSubAgentEntry(acc, parsed)
      } catch {
        /* skip a malformed line */
      }
    }
    this.dirty = true
  }

  private emit(): void {
    const out: Record<string, SubAgentState> = {}
    for (const [agentId, meta] of this.metaByAgent) {
      const toolUseId = meta.toolUseId
      if (!toolUseId) continue // can't link without it — skip (design spec §8)
      // INVARIANT 6: read the LIVE accumulator each emit and resolve terminal
      // done/error here at build time. A late parentResult flip (parent
      // tool_result lands after the subagent's last line) therefore re-renders on
      // the next emit without any state stored in the accumulator. An agent whose
      // meta exists but whose jsonl hasn't been read yet folds an empty
      // accumulator → the same "header only" state the old empty-array path gave.
      const acc = this.accByAgent.get(agentId) ?? createAccumulator()
      const { done, error } = this.parentResult(toolUseId)
      out[toolUseId] = buildSubAgentStateFromAccumulator(
        acc,
        toolUseId,
        agentId,
        meta,
        done,
        error,
      )
    }
    this.onChange(out)
  }
}
