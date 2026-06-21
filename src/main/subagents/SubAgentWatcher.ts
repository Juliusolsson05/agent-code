import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubAgentState } from '@preload/api/types.js'
import { buildSubAgentState, type SubAgentMeta } from './subagentState.js'
import { makeStringPool, internEntryFields } from '@main/sessions/internEntry.js'

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

// #288 (root cause): cap the BYTE SIZE of every retained free-text field, not
// just the entry COUNT.
//
// A dominator-tree heap analysis (scripts/analyze-heapsnapshot.mjs --owners)
// proved that 7 live SubAgentWatcher instances retained 263 MB — 88% of the
// entire reachable main-process heap — via the chain
//   SubAgentWatcher.entriesByAgent (Map<agentId, RawEntry[]>)
//     → entry → message.content → huge string.
// PR #300 capped MAX_RETAINED_ENTRIES_PER_AGENT=500 but did NOT bound the bytes
// per entry, so each of those 500 retained entries still pinned its FULL body:
// Read tool outputs, tool_result bodies, the skills-list attachment, and
// `[Truncated: PARTIAL view]` system-reminders. 500 entries × multi-MB bodies ×
// several agents × 7 watchers = 263 MB, and churning those multi-MB strings on
// every 600 ms poll fragments V8 into ~1.5 GB RSS.
//
// The mini-feed this watcher feeds is a LIVENESS affordance, not a transcript
// archive. buildSubAgentState only reads structure (block types, tool names,
// tool_use_id, is_error, timestamps) plus an ≤80-char headline per tool call —
// it never renders a full body. So truncating the large free-text payloads at
// retention to a cap well above what the renderer shows is invisible to the
// user while removing the bytes that caused the leak. The durable full
// transcript always stays on disk in the agent-<id>.jsonl, which is the source
// of truth if a future UI wants deep drill-in.
//
// 8 KB is generous: it is ~100× the 80-char headline buildSubAgentState renders
// from any single field, so no rendered value can ever be clipped by this cap,
// yet it turns a multi-MB Read result into a few KB. We truncate per-field
// (not per-entry) so an entry with several blocks each keeps its own budget.
//
// NOTE on units: this is a UTF-16 *character* cap (`String.length` counts code
// units, not bytes) — the truncation marker says "chars" to match. We don't
// convert to bytes because the goal is a generous BOUND, not an exact size, and
// a char count is the cheapest thing to compute on this per-appended-line path.
const MAX_ENTRY_FIELD_BYTES = 8 * 1024

// truncateEntryBodies: clamp the large free-text string fields of a freshly
// parsed RawEntry in place, PRESERVING every structural field buildSubAgentState
// reads (entry `type`/`uuid`, `message.role`/`type`, each block's `type`, tool
// `name`/`id`/`tool_use_id`, `is_error`/status, timestamps). We only shrink the
// payloads that carry the megabytes:
//   - TOP-LEVEL `entry.content` string and `entry.attachment.content` string.
//     Some entries have NO `message` field at all — most importantly the
//     `skill_listing` attachment whose `content` is the full skills list. That
//     shape was the single LARGEST duplicated leak category in the heap (×803).
//     It is handled at the entry root, BEFORE/independent of the message walk,
//     because there is no `message.content` array to descend into — the old
//     early-return ("not an array") skipped these entries entirely and made the
//     per-block `attachment.content` clamp below dead code for the real shape.
//   - `message.content` when it is a plain STRING. Claude transcripts use a
//     string body (large pasted user prompts, compact/user string messages,
//     string-shaped system reminders) as readily as the array-of-blocks shape;
//     the old early-return pinned every string body full-size.
//   - text/thinking blocks' `text`/`thinking`
//   - tool_result blocks' `content`/`output` (string OR array-of-{text} shape)
//   - string values inside a tool_use `input`, INCLUDING NESTED ones — e.g.
//     MultiEdit's `input.edits[].old_string`/`new_string`, which a flat
//     top-level-only walk left pinned. We recurse (bounded) so nested text is
//     clamped while every key and the input's structure stay intact.
//   - a per-block `attachment.content` (skills lists can also ride inside blocks)
// Each clamp appends an honest marker so a future reader of the in-memory entry
// knows chars were dropped and where the full body lives. This runs once per
// appended line at the single parse/push site below — never on a hot render
// path — so the cost is bounded by new bytes, matching the watcher's invariant.
function clampString(value: string, cap: number): string {
  if (value.length <= cap) return value
  const dropped = value.length - cap
  // CRITICAL (#288): `value.slice(0, cap)` returns a V8 SlicedString that RETAINS
  // the entire parent string — so truncating with a bare slice frees ZERO memory
  // (the multi-MB body we are trying to drop stays alive behind the slice, which
  // is exactly why #320 reduced the heap by nothing). Proven empirically: clamping
  // 2000×200KB strings via slice left ~194MB pinned; via the Buffer round-trip
  // below, ~19MB. Round-tripping the prefix through a Buffer copies its bytes into
  // fresh, parent-independent storage, so the original body becomes GC-eligible.
  // `utf16le` preserves every JS code unit exactly (incl. lone surrogates), so the
  // visible prefix is byte-identical to a plain slice — only the retention differs.
  const head = Buffer.from(value.slice(0, cap), 'utf16le').toString('utf16le')
  return head + `… [truncated ${dropped} chars — full body on disk]`
}

// clampDeep: recursively clamp every string VALUE reachable inside an arbitrary
// tool_use `input`, preserving all keys, array order, and object structure.
// WHY recursion (not the old flat top-level-only loop): structured tool inputs
// bury their large text below the first level — MultiEdit puts each edit's
// `old_string`/`new_string` under `input.edits[i]`, and other tools nest text
// under sub-objects/arrays. A flat walk only saw the top-level string values
// and left those nested megabytes pinned. We bound recursion at `depth` (≤6) so
// a pathologically deep object can't blow the stack or burn the per-line budget;
// nothing deeper than that is a realistic tool-input text payload, and the
// durable full copy is on disk regardless. Only string VALUES are rewritten —
// keys and the shape headlineFromInput reads (command/file_path/…) are untouched.
function clampDeep(value: unknown, cap: number, depth: number): unknown {
  if (typeof value === 'string') return clampString(value, cap)
  if (depth <= 0 || !value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = clampDeep(value[i], cap, depth - 1)
    return value
  }
  const obj = value as Record<string, unknown>
  for (const k of Object.keys(obj)) obj[k] = clampDeep(obj[k], cap, depth - 1)
  return obj
}

// Deepest nesting we recurse when clamping an entry. The big bodies sit shallow
// (`entry.toolUseResult.file.content` ≈ depth 3; `message.content[i].content[j]
// .text` ≈ depth 6); 12 is generous headroom while still bounding the walk so a
// pathological object can't blow the stack or burn the per-line budget.
const ENTRY_CLAMP_DEPTH = 12

function truncateEntryBodies(entry: unknown, cap: number): void {
  // #288 (fix for the #320 miss): clamp EVERY large free-text string ANYWHERE in
  // the entry by recursing the whole object — not a hand-maintained list of fields.
  //
  // WHY the previous field-by-field walk was wrong: it only visited
  // `message.content` / `attachment` / bare `content`, but Claude writes the FULL
  // Read/tool output to the TOP-LEVEL `toolUseResult` field
  // (`toolUseResult.file.content`, `stdout`, `stderr`) — *in addition* to the
  // tool_result block. The dominator tree's bytes actually lived in
  // `toolUseResult`, which the targeted walk never touched, so retained entries
  // stayed full-size and #320 freed almost nothing. A recursive clamp catches
  // toolUseResult, message.content (string OR array), attachments, tool_use input,
  // and any future shape — no more whack-a-mole.
  //
  // WHY it's safe / invisible: `clampString` is a no-op for strings under `cap`,
  // so short structural fields (type/uuid/role/name/id/tool_use_id/timestamps) are
  // returned untouched; only multi-KB bodies are clamped. `buildSubAgentState`
  // only ever renders ≤80-char headlines, so clamping at `cap` (8 KB) can never
  // change a rendered value. `clampDeep` rewrites string VALUES in place and
  // preserves all keys and array order. Durable full bodies stay on disk.
  clampDeep(entry, cap, ENTRY_CLAMP_DEPTH)
}

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
  // #288: per-watcher string pool. This watcher retains up to
  // MAX_RETAINED_ENTRIES_PER_AGENT parsed RawEntry objects PER subagent
  // across a whole Task fan-out, each freshly JSON.parsed below, so the
  // same cwd/role/type metadata is re-minted on every appended line.
  // Interning against a pool scoped to this watcher shares the canonical
  // strings across all of its agents' entries. The pool's lifetime is the
  // watcher's — cleared in stop() (one watcher per session) — so it can
  // never grow into the global leak a shared pool would be.
  private intern = makeStringPool()

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
    // #288: drop the interning pool's backing Map so the strings it pinned
    // are released with the rest of this watcher's state. Reassigning a
    // fresh empty pool is the cheapest way to let the old Map GC.
    this.intern = makeStringPool()
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
        const parsed = JSON.parse(t) as RawEntry
        // #288 (root cause): clamp the large free-text bodies BEFORE retaining,
        // so the 263 MB the dominator tree attributed to entriesByAgent → entry
        // → message.content → huge string can never accumulate. Done here, at the
        // single parse/push site, the cap applies to every entry exactly once and
        // the durable full body stays on disk. See truncateEntryBodies above.
        truncateEntryBodies(parsed, MAX_ENTRY_FIELD_BYTES)
        // #288: intern the duplicated metadata (type, message.role/type, …)
        // before retaining. internEntryFields is defensive and never throws,
        // so a malformed entry that slipped past JSON.parse still can't take
        // down this loop. Value-equality is preserved — buildSubAgentState
        // reads the same fields it always did.
        internEntryFields(parsed as Record<string, unknown>, this.intern)
        arr.push(parsed)
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
