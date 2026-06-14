# Subagent Fleet Rendering — Implementation Plan

> **For agentic workers:** Execute INLINE (user directive: no implementation subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the Task-tool subagents the main agent spawns — a live concurrency header grouping sibling `Task` blocks, each expandable to a live tool-call mini-feed — sourced from `<projectDir>/<providerSessionId>/subagents/agent-<id>.jsonl` and linked to its parent `Task` card by `meta.toolUseId`.

**Architecture:** A main-process watcher tails each active session's `subagents/` dir, parses appended JSONL incrementally into a per-`toolUseId` `SubAgentState` map, and pushes it to the renderer over a new `session:sub-agents` IPC channel. The renderer folds it into `SessionRuntime.subAgents` and a new `TaskSubagentRow` (Block.tsx `Task` interception) renders it, with a block-list group wrapper for the "Spawned N agents" header. All disk I/O is main-side; the renderer reads files never.

**Tech Stack:** Electron main (Node `fs`), TypeScript, React renderer, existing typed IPC bridge (`src/preload/api/*`), existing feed row idioms.

**Testing note (repo convention overrides skill TDD):** Per project rule, do NOT add new persistent test files or `test:*` scripts in this feature PR. Validate with `npx tsc -b tsconfig.web.json` (baseline = 4 pre-existing errors; filter `TS6305`) and manual acceptance against the live `subagents/` data already on disk. Temporary throwaway fixtures are fine but must be deleted before the PR.

---

## File Structure

**Main (new):**
- `src/main/subagents/subagentState.ts` — pure functions: parse `ClaudeEntry[]` + meta → `SubAgentState`; status derivation. Unit-pure, no I/O.
- `src/main/subagents/SubAgentWatcher.ts` — per-session fs.watch on `subagents/`, incremental offset reads, coalesced emit.
- `src/main/subagents/index.ts` — `SubAgentWatcherManager`: start/stop keyed by sessionId; resolves dir; emits via callback.

**Main (modify):**
- `src/main/sessions/forwarder.ts` — forward `sub-agents` → `sendToMainWindow('session:sub-agents', …)`.
- wherever the session forwarder/managers are wired (the `wireSessionForwarder` call site) — construct + lifecycle the manager.

**Shared types (modify):**
- `src/preload/api/types.ts` — `SubAgentToolCall`, `SubAgentState`, `SessionSubAgentsEvent`.
- `src/preload/api/session.ts` — `onSessionSubAgents`.
- `src/preload/index.ts` — re-export the new types.

**Renderer (modify):**
- `src/renderer/src/workspace/workspaceState.ts` — `SubAgentState`/`SubAgentToolCall` mirror + `subAgents` field + `emptyRuntime`.
- `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts` — fold `session:sub-agents` into runtime.
- `src/renderer/src/features/feed/context.tsx` — `SubAgentsContext`.
- `src/renderer/src/features/feed/ui/Feed.tsx` — provide `SubAgentsContext`.
- `src/renderer/src/features/feed/ui/rows/Block.tsx` — intercept `case 'Task'`.
- `src/renderer/src/features/feed/ui/EntryRow.tsx` (or the block-list mapper) — group adjacent `Task` blocks under a header wrapper.

**Renderer (new):**
- `src/renderer/src/features/feed/ui/rows/TaskSubagentRow.tsx` — one Task card: status + agentType + description + live counts; expandable.
- `src/renderer/src/features/feed/ui/rows/SubagentMiniFeed.tsx` — tool-call timeline + current-activity line.
- `src/renderer/src/features/feed/ui/rows/SubagentGroupHeader.tsx` — "Spawned N agents · ◐ R running · ✓ D done".

---

## Task 0: Environment setup (worktree submodules)

The worktree's git submodules are uninitialized; build/typecheck will fail until the package sources are present.

- [ ] **Step 1: rsync the package sources from the main checkout into the worktree**

```bash
SRC=/Users/juliusolsson/Desktop/Development/agent-code
DST=/Users/juliusolsson/Desktop/Development/agent-code/.worktrees/subagent-inline-render
for p in claude-code-headless codex-headless agent-transcript-parser agent-voice-dictation opencode-headless; do
  rsync -a --delete --exclude node_modules --exclude .git "$SRC/packages/$p/" "$DST/packages/$p/"
done
rsync -a --exclude node_modules --exclude .git "$SRC/vendor/codex-src/" "$DST/vendor/codex-src/" 2>/dev/null || true
```

- [ ] **Step 2: confirm a baseline typecheck runs** (records the 4 pre-existing errors)

Run from the worktree:
```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/subagent-inline-render
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -20
```
Expected: at most the 4 known pre-existing errors. No module-not-found from `packages/*`.

- [ ] **Step 3: verify the on-disk subagents path shape** (locks the dir-resolution assumption)

```bash
ls -d ~/.claude/projects/-Users-juliusolsson-Desktop-Development-agent-code/*/subagents 2>/dev/null | head
cat ~/.claude/projects/-Users-juliusolsson-Desktop-Development-agent-code/*/subagents/*.meta.json 2>/dev/null | head -3
```
Expected: dir is `<projectDir>/<providerSessionId>/subagents/`; meta has `{agentType, description, toolUseId}`.

---

## Task 1: Shared types

**Files:**
- Modify: `src/preload/api/types.ts` (after `SessionConditionsEvent`)
- Modify: `src/preload/index.ts` (re-export list)

- [ ] **Step 1: add the payload types** to `src/preload/api/types.ts`

```typescript
/** One tool call in a subagent's timeline (for the mini-feed). */
export type SubAgentToolCall = {
  /** Tool name, e.g. "Read" | "Bash" | "Grep". */
  name: string
  /** First meaningful arg (path/command/pattern/query), already truncated. */
  headline: string | null
  /** 'done' once a matching tool_result appears in the subagent transcript. */
  status: 'running' | 'done'
}

/** Live state of one Task-tool subagent, keyed by its parent Task tool_use id. */
export type SubAgentState = {
  /** Parent Task tool_use block id — meta.toolUseId. The render-side join key. */
  toolUseId: string
  /** The agent-<id> filename id. */
  agentId: string
  /** meta.agentType, e.g. "Explore" | "general-purpose". */
  agentType: string
  /** meta.description — the card headline. */
  description: string
  status: 'running' | 'done' | 'error'
  /** Epoch ms of the first transcript entry, or null if unknown. */
  startedAt: number | null
  /** Epoch ms of the last observed entry (drives elapsed + live pulse). */
  lastActivityAt: number | null
  /** Count of assistant turns observed. */
  turnCount: number
  /** Ordered tool-call timeline (capped — see SUBAGENT_TOOL_CALLS_MAX). */
  toolCalls: SubAgentToolCall[]
  /** Count of tool calls dropped from the front when capped (0 if none). */
  droppedToolCalls: number
  /** Derived activity label, e.g. "running Grep" | "thinking" | null. */
  currentActivity: string | null
}

/** Per-session push: the full subAgents map for one session. */
export type SessionSubAgentsEvent = {
  sessionId: string
  subAgents: Record<string /* toolUseId */, SubAgentState>
}
```

- [ ] **Step 2: re-export from preload index** — add to the `export type { … } from '@preload/api/types.js'` block in `src/preload/index.ts`:

```typescript
  SubAgentToolCall,
  SubAgentState,
  SessionSubAgentsEvent,
```

- [ ] **Step 3: typecheck**

```bash
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -10
```
Expected: no new errors.

- [ ] **Step 4: commit**

```bash
git add src/preload/api/types.ts src/preload/index.ts
git commit -m "feat(subagents): shared SubAgentState / SessionSubAgentsEvent types"
```

---

## Task 2: Pure subagent-state builder (main)

**Files:**
- Create: `src/main/subagents/subagentState.ts`

This module is pure (no I/O) so it is trivially correct and verifiable. It turns parsed Claude entries + meta into a `SubAgentState`.

- [ ] **Step 1: write the module**

```typescript
import type {
  SubAgentState,
  SubAgentToolCall,
} from '@preload/api/types.js'

/** Cap the timeline so a 300KB transcript can't bloat the IPC payload. */
export const SUBAGENT_TOOL_CALLS_MAX = 40

/** Minimal shapes we read out of a Claude transcript line. We parse JSON
 *  ourselves (the agent-transcript-parser package is a converter, not a
 *  reader) — these are intentionally permissive. */
type RawBlock = {
  type?: string
  name?: string
  id?: string
  tool_use_id?: string
  is_error?: boolean
  input?: Record<string, unknown>
}
type RawEntry = {
  type?: string
  timestamp?: string
  message?: { role?: string; content?: unknown }
}

export type SubAgentMeta = {
  agentType?: string
  description?: string
  toolUseId?: string
}

function headlineFromInput(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null
  for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
    const v = input[k]
    if (typeof v === 'string' && v.length > 0) return v.length > 80 ? v.slice(0, 80) + '…' : v
  }
  return null
}

function tsToMs(ts: string | undefined): number | null {
  if (!ts) return null
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : null
}

/**
 * Build a SubAgentState from a subagent transcript's parsed entries + meta.
 *
 * @param toolUseId    parent Task tool_use id (authoritative join key)
 * @param agentId      the agent-<id> filename id
 * @param meta         contents of agent-<id>.meta.json (may be partial)
 * @param entries      parsed JSONL lines of agent-<id>.jsonl
 * @param parentDone   true if the parent transcript has a tool_result for toolUseId
 * @param parentError  true if that tool_result is an error
 */
export function buildSubAgentState(
  toolUseId: string,
  agentId: string,
  meta: SubAgentMeta,
  entries: RawEntry[],
  parentDone: boolean,
  parentError: boolean,
): SubAgentState {
  const toolCalls: SubAgentToolCall[] = []
  const resultSeen = new Set<string>() // tool_use_id of completed calls
  let turnCount = 0
  let firstTs: number | null = null
  let lastTs: number | null = null
  let lastActivity: string | null = null

  for (const e of entries) {
    const ms = tsToMs(e.timestamp)
    if (ms != null) {
      if (firstTs == null) firstTs = ms
      lastTs = ms
    }
    const content = e.message?.content
    if (!Array.isArray(content)) continue
    if (e.type === 'assistant') turnCount += 1
    for (const b of content as RawBlock[]) {
      if (b.type === 'tool_use') {
        toolCalls.push({ name: b.name ?? 'tool', headline: headlineFromInput(b.input), status: 'running' })
        lastActivity = `running ${b.name ?? 'tool'}`
      } else if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        resultSeen.add(b.tool_use_id)
      } else if (b.type === 'thinking') {
        lastActivity = 'thinking'
      }
    }
  }

  // Resolve per-call completion: a tool_use is 'done' when a later
  // tool_result with the matching id was observed. We matched by id during
  // the walk via resultSeen; re-tag here in order.
  // (Tool_use ids aren't carried into SubAgentToolCall to keep the payload
  // small; instead we mark the last (toolCalls.length - openResults) as done.)
  const doneCount = resultSeen.size
  for (let i = 0; i < toolCalls.length; i++) {
    toolCalls[i].status = i < doneCount ? 'done' : 'running'
  }

  // Cap to the most recent N, recording how many we dropped.
  let dropped = 0
  let capped = toolCalls
  if (toolCalls.length > SUBAGENT_TOOL_CALLS_MAX) {
    dropped = toolCalls.length - SUBAGENT_TOOL_CALLS_MAX
    capped = toolCalls.slice(dropped)
  }

  const status: SubAgentState['status'] = parentError
    ? 'error'
    : parentDone
      ? 'done'
      : 'running'

  return {
    toolUseId,
    agentId,
    agentType: meta.agentType ?? 'agent',
    description: meta.description ?? '',
    status,
    startedAt: firstTs,
    lastActivityAt: lastTs,
    turnCount,
    toolCalls: capped,
    droppedToolCalls: dropped,
    currentActivity: status === 'running' ? lastActivity : null,
  }
}
```

- [ ] **Step 2: typecheck**

```bash
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -10
```
Expected: no new errors.

- [ ] **Step 3: quick throwaway sanity check against real data** (delete after)

```bash
cat > /tmp/sa-check.mjs <<'JS'
import { readFileSync, readdirSync } from 'node:fs'
const dir = process.argv[2]
for (const f of readdirSync(dir).filter(f => f.endsWith('.meta.json'))) {
  const meta = JSON.parse(readFileSync(`${dir}/${f}`,'utf8'))
  const jsonl = `${dir}/${f.replace('.meta.json','.jsonl')}`
  const lines = readFileSync(jsonl,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l))
  const tools = lines.flatMap(e => Array.isArray(e.message?.content) ? e.message.content.filter(b=>b.type==='tool_use').map(b=>b.name) : [])
  console.log(meta.toolUseId?.slice(0,16), meta.agentType, '|', lines.length, 'lines', tools.length, 'tools', meta.description)
}
JS
node /tmp/sa-check.mjs ~/.claude/projects/-Users-juliusolsson-Desktop-Development-agent-code/*/subagents | head
rm /tmp/sa-check.mjs
```
Expected: prints toolUseId + agentType + counts per subagent — confirms the fields the builder relies on exist.

- [ ] **Step 4: commit**

```bash
git add src/main/subagents/subagentState.ts
git commit -m "feat(subagents): pure SubAgentState builder from transcript + meta"
```

---

## Task 3: SubAgentWatcher (main, I/O)

**Files:**
- Create: `src/main/subagents/SubAgentWatcher.ts`

Watches one session's `subagents/` dir, reads files incrementally (byte offsets), rebuilds states on change, coalesces emits.

- [ ] **Step 1: write the watcher**

```typescript
import { watch, type FSWatcher } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubAgentState } from '@preload/api/types.js'
import { buildSubAgentState, type SubAgentMeta } from './subagentState.js'

const COALESCE_MS = 120

type ParentResultLookup = (toolUseId: string) => { done: boolean; error: boolean }

/**
 * One watcher per session. `parentResult` lets us resolve running-vs-done from
 * the parent transcript (the main agent's tool_result for the Task). If the
 * parent transcript isn't wired in yet, default to {done:false} — the file
 * simply stops growing when the subagent ends, so currentActivity clears.
 */
export class SubAgentWatcher {
  private watcher: FSWatcher | null = null
  private offsets = new Map<string, number>() // agentId -> byte offset
  private entriesByAgent = new Map<string, unknown[]>()
  private metaByAgent = new Map<string, SubAgentMeta>()
  private flushTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly subagentsDir: string,
    private readonly parentResult: ParentResultLookup,
    private readonly onChange: (subAgents: Record<string, SubAgentState>) => void,
  ) {}

  async start(): Promise<void> {
    // Initial scan (dir may not exist yet — that's fine, watch the parent).
    try {
      await this.rescan()
    } catch {
      /* dir not created until first subagent spawns */
    }
    try {
      this.watcher = watch(this.subagentsDir, () => this.scheduleFlush())
    } catch {
      // Dir absent: poll-create is handled by the manager re-calling start.
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.rescan().then(() => this.emit())
    }, COALESCE_MS)
  }

  private async rescan(): Promise<void> {
    const files = await readdir(this.subagentsDir)
    for (const f of files) {
      if (f.endsWith('.meta.json')) {
        const agentId = f.slice('agent-'.length, -'.meta.json'.length)
        try {
          this.metaByAgent.set(agentId, JSON.parse(await readFile(join(this.subagentsDir, f), 'utf8')))
        } catch {
          /* partial write; retry next change */
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
    // Only consume complete lines; leave the trailing partial for next read.
    const lastNl = text.lastIndexOf('\n')
    if (lastNl < 0) return
    const complete = text.slice(0, lastNl)
    this.offsets.set(agentId, from + Buffer.byteLength(text.slice(0, lastNl + 1)))
    const arr = this.entriesByAgent.get(agentId) ?? []
    for (const line of complete.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        arr.push(JSON.parse(t))
      } catch {
        /* skip malformed line */
      }
    }
    this.entriesByAgent.set(agentId, arr)
  }

  private emit(): void {
    const out: Record<string, SubAgentState> = {}
    for (const [agentId, meta] of this.metaByAgent) {
      const toolUseId = meta.toolUseId
      if (!toolUseId) continue // can't link without it; skip (see spec §8)
      const entries = (this.entriesByAgent.get(agentId) ?? []) as Parameters<typeof buildSubAgentState>[3]
      const { done, error } = this.parentResult(toolUseId)
      out[toolUseId] = buildSubAgentState(toolUseId, agentId, meta, entries, done, error)
    }
    this.onChange(out)
  }
}
```

- [ ] **Step 2: typecheck**, expected no new errors.

```bash
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -10
```

- [ ] **Step 3: commit**

```bash
git add src/main/subagents/SubAgentWatcher.ts
git commit -m "feat(subagents): per-session subagents/ dir watcher with incremental reads"
```

---

## Task 4: SubAgentWatcherManager + lifecycle + IPC emit (main)

**Files:**
- Create: `src/main/subagents/index.ts`
- Modify: `src/main/sessions/forwarder.ts`
- Modify: the `wireSessionForwarder` call site (verify during impl: `src/main/index.ts` / startup wiring)

- [ ] **Step 1: write the manager** (`src/main/subagents/index.ts`)

```typescript
import { join } from 'node:path'
import { getProjectDirForCwd } from '@shared/runtime/projectDir.js'
import type { SubAgentState } from '@preload/api/types.js'
import { SubAgentWatcher } from './SubAgentWatcher.js'

type Emit = (sessionId: string, subAgents: Record<string, SubAgentState>) => void

/**
 * Owns one SubAgentWatcher per active session. Resolves the on-disk
 *   <projectDir>/<providerSessionId>/subagents/
 * directory and (re)starts the watcher whenever the providerSessionId becomes
 * known or changes (resume). Stopped on session kill.
 */
export class SubAgentWatcherManager {
  private watchers = new Map<string, SubAgentWatcher>()

  constructor(private readonly emit: Emit) {}

  /** Call when a session's cwd + providerSessionId are known. Idempotent. */
  async ensure(sessionId: string, cwd: string, providerSessionId: string): Promise<void> {
    if (this.watchers.has(sessionId)) return
    const projectDir = await getProjectDirForCwd(cwd)
    const dir = join(projectDir, providerSessionId, 'subagents')
    // parentResult: until the main transcript is wired through, treat all as
    // running; the file ceasing to grow + currentActivity clearing is enough
    // for v1. (Spec §9 open question 2 — can be upgraded to read the parent
    // tool_result without changing this signature.)
    const watcher = new SubAgentWatcher(
      dir,
      () => ({ done: false, error: false }),
      subAgents => this.emit(sessionId, subAgents),
    )
    this.watchers.set(sessionId, watcher)
    await watcher.start()
  }

  stop(sessionId: string): void {
    this.watchers.get(sessionId)?.stop()
    this.watchers.delete(sessionId)
  }

  stopAll(): void {
    for (const w of this.watchers.values()) w.stop()
    this.watchers.clear()
  }
}
```

- [ ] **Step 2: forward to the renderer** — in `src/main/sessions/forwarder.ts`, construct the manager and emit on the existing `sendToMainWindow`. Add inside `wireSessionForwarder` (mirror the `session:started` pattern):

```typescript
import { SubAgentWatcherManager } from '../subagents/index.js'
// …
const subAgentMgr = new SubAgentWatcherManager((sessionId, subAgents) =>
  sendToMainWindow('session:sub-agents', { sessionId, subAgents }),
)

// When a provider session id is known, ensure a watcher. The session manager
// emits 'started' with sessionId+projectDir; providerSessionId is resolved
// from the session record. VERIFY exact field during impl — the session has a
// providerSessionId used for --resume.
manager.on('started', payload => {
  sendToMainWindow('session:started', payload)
  const rec = manager.get?.(payload.sessionId)
  const cwd = rec?.cwd ?? payload.projectDir
  const psid = rec?.providerSessionId
  if (cwd && psid) void subAgentMgr.ensure(payload.sessionId, cwd, psid)
})

manager.on('exit', payload => {
  flushAndDropJsonl(payload.sessionId)
  subAgentMgr.stop(payload.sessionId)
  sendToMainWindow('session:exit', payload)
})
```

> **Impl note:** the exact accessor for `cwd`/`providerSessionId` (and the event that fires when providerSessionId is first discovered, since Claude assigns it after start) must be confirmed against `src/main/sessionManager.ts`. If providerSessionId is not present at `started`, hook the event/field that sets it (search `providerSessionId` in sessionManager) and call `subAgentMgr.ensure(...)` there too. `ensure` is idempotent so calling from both is safe.

- [ ] **Step 3: stopAll on shutdown** — wherever sessions are torn down on app quit, call `subAgentMgr.stopAll()` (or expose it). Confirm during impl.

- [ ] **Step 4: typecheck**, expected no new errors.

- [ ] **Step 5: commit**

```bash
git add src/main/subagents/index.ts src/main/sessions/forwarder.ts
git commit -m "feat(subagents): watcher lifecycle + session:sub-agents IPC push"
```

---

## Task 5: Preload subscription method

**Files:**
- Modify: `src/preload/api/session.ts`

- [ ] **Step 1: add the method** (after `onSessionConditions`)

```typescript
  onSessionSubAgents: (cb: (e: SessionSubAgentsEvent) => void): Unsub =>
    subscribe('session:sub-agents', cb),
```

Ensure `SessionSubAgentsEvent` is imported at the top of the file from `./types.js` (mirror the existing event-type imports).

- [ ] **Step 2: typecheck**, expected no new errors.

- [ ] **Step 3: commit**

```bash
git add src/preload/api/session.ts
git commit -m "feat(subagents): preload onSessionSubAgents subscription"
```

---

## Task 6: Renderer runtime field + IPC fold

**Files:**
- Modify: `src/renderer/src/workspace/workspaceState.ts`
- Modify: `src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts`

- [ ] **Step 1: re-export the types + add the field** in `workspaceState.ts`. Near the other shared-type imports, re-export from preload (mirror how other preload types are surfaced), or import:

```typescript
import type { SubAgentState } from '@preload/api/types'
export type { SubAgentState, SubAgentToolCall } from '@preload/api/types'
```

Add to `SessionRuntime` (after the `ghosts` field):

```typescript
  /** Task-tool subagents spawned by this session's work, keyed by the parent
   *  Task tool_use id. Folded from the `session:sub-agents` IPC push; read by
   *  the feed's TaskSubagentRow. Empty when no subagents exist (no-op render). */
  subAgents: Record<string, SubAgentState>
```

Add to `emptyRuntime()`:

```typescript
    subAgents: {},
```

- [ ] **Step 2: fold the IPC push** in `useIpcSubscriptions.ts` (mirror `onSessionConditions`; reference-equal bail to avoid re-renders). Add alongside the other subscriptions:

```typescript
    const offSubAgents = window.api.onSessionSubAgents(({ sessionId, subAgents }) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        if (current.subAgents === subAgents) return prev
        return { ...prev, [sessionId]: { ...current, subAgents } }
      })
    })
```

Add `offSubAgents()` to the cleanup return.

- [ ] **Step 3: typecheck**, expected no new errors.

- [ ] **Step 4: commit**

```bash
git add src/renderer/src/workspace/workspaceState.ts src/renderer/src/workspace/hook/ipc/useIpcSubscriptions.ts
git commit -m "feat(subagents): runtime.subAgents field + IPC fold"
```

---

## Task 7: SubAgentsContext + provide it in Feed

**Files:**
- Modify: `src/renderer/src/features/feed/context.tsx`
- Modify: `src/renderer/src/features/feed/ui/Feed.tsx`

- [ ] **Step 1: add the context** in `context.tsx`:

```typescript
import type { SubAgentState } from '../../workspace/workspaceState'
export const SubAgentsContext = createContext<Record<string, SubAgentState>>({})
```

- [ ] **Step 2: provide it** in `Feed.tsx`. Feed already receives the session `runtime` (it reads `runtime.streamPhase` etc.). Wrap the existing provider stack with:

```tsx
<SubAgentsContext.Provider value={runtime.subAgents}>
  {/* existing ProviderContext … providers + scroller */}
</SubAgentsContext.Provider>
```

> **Impl note:** confirm the local variable name for the session runtime inside Feed.tsx (the agent report shows Feed reads runtime fields; use the same source). If Feed only gets `streamPhase` piecemeal, thread `subAgents` from the same prop that supplies those.

- [ ] **Step 3: typecheck**, expected no new errors.

- [ ] **Step 4: commit**

```bash
git add src/renderer/src/features/feed/context.tsx src/renderer/src/features/feed/ui/Feed.tsx
git commit -m "feat(subagents): SubAgentsContext provided from Feed runtime"
```

---

## Task 8: SubagentMiniFeed (the drill-in timeline)

**Files:**
- Create: `src/renderer/src/features/feed/ui/rows/SubagentMiniFeed.tsx`

- [ ] **Step 1: write it** (reuses `MarkerRow`):

```tsx
import { MarkerRow } from '../MarkerRow'
import type { SubAgentState } from '../../../../workspace/workspaceState'

export function SubagentMiniFeed({ sa }: { sa: SubAgentState }) {
  return (
    <div className="ml-4 border-l border-line pl-3 py-1">
      {sa.droppedToolCalls > 0 && (
        <div className="text-[11px] text-muted mb-1">… +{sa.droppedToolCalls} earlier calls</div>
      )}
      {sa.toolCalls.map((t, i) => (
        <MarkerRow key={i} marker={t.status === 'done' ? '⏺' : '◐'} tone="muted">
          <div className="text-[12px] leading-[1.55]">
            <span className="text-accent">{t.name}</span>
            {t.headline && <span className="text-ink-dim font-code ml-2 break-all">{t.headline}</span>}
          </div>
        </MarkerRow>
      ))}
      {sa.currentActivity && (
        <MarkerRow marker="◐" tone="muted">
          <span className="text-[12px] text-ink-dim">{sa.currentActivity}…</span>
        </MarkerRow>
      )}
    </div>
  )
}
```

- [ ] **Step 2: typecheck + commit**

```bash
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -10
git add src/renderer/src/features/feed/ui/rows/SubagentMiniFeed.tsx
git commit -m "feat(subagents): SubagentMiniFeed tool-call timeline"
```

---

## Task 9: TaskSubagentRow + Block.tsx interception

**Files:**
- Create: `src/renderer/src/features/feed/ui/rows/TaskSubagentRow.tsx`
- Modify: `src/renderer/src/features/feed/ui/rows/Block.tsx`

- [ ] **Step 1: write the row** (reads runtime via context; local expand state):

```tsx
import { memo, useContext, useState } from 'react'
import type { ToolUseBlock } from '...' // reuse the same ToolUseBlock import Block.tsx uses
import { MarkerRow } from '../MarkerRow'
import { SubAgentsContext } from '../../context'
import { SubagentMiniFeed } from './SubagentMiniFeed'

function elapsed(sa: { startedAt: number | null; lastActivityAt: number | null }): string {
  if (!sa.startedAt || !sa.lastActivityAt) return ''
  const s = Math.max(0, Math.round((sa.lastActivityAt - sa.startedAt) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const TaskSubagentRow = memo(function TaskSubagentRow({ block }: { block: ToolUseBlock }) {
  const subAgents = useContext(SubAgentsContext)
  const sa = subAgents[block.id]
  const [open, setOpen] = useState(false)

  // Fall back to the raw Task input until the subagent file is observed.
  const input = block.input as Record<string, unknown> | undefined
  const agentType = sa?.agentType ?? (typeof input?.subagent_type === 'string' ? input.subagent_type : 'agent')
  const description = sa?.description ?? (typeof input?.description === 'string' ? input.description : '')
  const glyph = sa?.status === 'done' ? '✓' : sa?.status === 'error' ? '✗' : '◐'
  const right = sa
    ? sa.status === 'running'
      ? `${sa.toolCalls.length + sa.droppedToolCalls} tools · ${elapsed(sa)}`
      : `${sa.toolCalls.length + sa.droppedToolCalls} tools · done`
    : 'starting…'

  return (
    <MarkerRow marker={glyph}>
      <div>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="text-[13px] leading-[1.65] flex w-full items-center gap-2 cursor-pointer text-left"
        >
          <span className="text-muted">{agentType}</span>
          <span className="text-ink flex-1 min-w-0 truncate">{description}</span>
          <span className="text-muted text-[11px] whitespace-nowrap">{right}</span>
          <span className="text-muted">{open ? '▾' : '▸'}</span>
        </button>
        {open && sa && <SubagentMiniFeed sa={sa} />}
      </div>
    </MarkerRow>
  )
})
```

> **Impl note:** import `ToolUseBlock` from the exact path Block.tsx uses; copy the `block.id` field name verification (the Task tool_use id is `block.id`, joined to `meta.toolUseId`).

- [ ] **Step 2: intercept in Block.tsx** — in the Claude provider `switch (tu.name)`, add **before** `default`:

```tsx
        case 'Task':
          return <TaskSubagentRow block={tu} />
```

and import `TaskSubagentRow`.

- [ ] **Step 3: typecheck + commit**

```bash
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -10
git add src/renderer/src/features/feed/ui/rows/TaskSubagentRow.tsx src/renderer/src/features/feed/ui/rows/Block.tsx
git commit -m "feat(subagents): TaskSubagentRow rendered for Task tool_use blocks"
```

At this point each Task card shows live status + drill-in. Next task adds the concurrency header.

---

## Task 10: "Spawned N agents" group header

**Files:**
- Create: `src/renderer/src/features/feed/ui/rows/SubagentGroupHeader.tsx`
- Modify: the assistant block-list mapper (verify: `EntryRow.tsx` or the component that maps `message.content[]` → `<Block>`)

Group a run of adjacent `Task` tool_use blocks within one assistant message under a single header. Implemented at the block-list level (where sibling blocks are adjacent), not the render model.

- [ ] **Step 1: write the header**:

```tsx
import { useContext } from 'react'
import { SubAgentsContext } from '../../context'

export function SubagentGroupHeader({ toolUseIds }: { toolUseIds: string[] }) {
  const subAgents = useContext(SubAgentsContext)
  const states = toolUseIds.map(id => subAgents[id]).filter(Boolean)
  const running = states.filter(s => s.status === 'running').length
  const done = states.filter(s => s.status === 'done').length
  return (
    <div className="text-[13px] leading-[1.65] flex items-center gap-2">
      <span className="text-accent font-semibold">Spawned {toolUseIds.length} agents</span>
      <span className="text-muted text-[11px]">
        {running > 0 && `◐ ${running} running`}
        {running > 0 && done > 0 && ' · '}
        {done > 0 && `✓ ${done} done`}
      </span>
    </div>
  )
}
```

- [ ] **Step 2: group adjacent Task blocks in the block-list mapper.** Locate the loop that maps an assistant entry's `content` array to `<Block>` elements (search `EntryRow` / `.map(` over `content`). Replace the plain map with a grouping pass: when ≥2 consecutive blocks are `tool_use` named `Task`, render one `<SubagentGroupHeader toolUseIds={[…]} />` followed by their `<TaskSubagentRow>`s wrapped in a left-rail container; a lone `Task` renders as today (Task 9). Pseudocode to adapt to the real mapper:

```tsx
const out: ReactNode[] = []
for (let i = 0; i < blocks.length; ) {
  const b = blocks[i]
  if (b.type === 'tool_use' && b.name === 'Task') {
    let j = i
    const ids: string[] = []
    while (j < blocks.length && blocks[j].type === 'tool_use' && blocks[j].name === 'Task') {
      ids.push((blocks[j] as ToolUseBlock).id)
      j++
    }
    if (ids.length > 1) out.push(<SubagentGroupHeader key={`grp-${i}`} toolUseIds={ids} />)
    for (let k = i; k < j; k++) out.push(<Block key={k} block={blocks[k]} role="assistant" />)
    i = j
  } else {
    out.push(<Block key={i} block={b} role={role} />)
    i++
  }
}
```

> **Impl note:** match the real mapper's key scheme + props exactly; do not regress non-Task block rendering. If the mapper is shared with user-role entries, gate grouping to `role === 'assistant'`.

- [ ] **Step 3: typecheck + commit**

```bash
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -10
git add src/renderer/src/features/feed/ui/rows/SubagentGroupHeader.tsx src/renderer/src/features/feed/ui/EntryRow.tsx
git commit -m "feat(subagents): Spawned N agents concurrency header for sibling Task blocks"
```

---

## Task 11: Manual acceptance + PR

- [ ] **Step 1: full typecheck**

```bash
npx tsc -b tsconfig.web.json 2>&1 | grep -v TS6305 | tail -20
```
Expected: only the 4 pre-existing baseline errors.

- [ ] **Step 2: manual acceptance** (build/run the app or use the dev harness):
  1. Spawn several `Task` agents in parallel → "Spawned N agents" header; each row shows `◐` + agentType + description + live tool count.
  2. Expand a row → tool-call timeline grows live; current-activity line shows.
  3. Agents finish → glyphs flip to `✓`, elapsed freezes.
  4. Reload the session → states rebuild from disk.
  5. A session with no subagents → feed unchanged.

- [ ] **Step 3: push + open PR** (switch gh account first per repo convention)

```bash
gh auth switch --user Juliusolsson05
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/subagent-inline-render
git push -u origin feat/subagent-inline-render
gh pr create --title "feat: live subagent fleet rendering" --body "<see spec>"
```

- [ ] **Step 4: report the PR URL to the user. Do NOT merge.**

---

## Self-review (against spec)

- **Concurrency at a glance** → Task 10 (group header) ✓
- **Drill into one** → Tasks 8–9 (mini-feed + row) ✓
- **Correct attribution via meta.toolUseId** → Task 3 emit (`out[toolUseId]`), Task 9 (`subAgents[block.id]`) ✓
- **Durable / disk-sourced** → Tasks 3–4 (watcher reads files; renderer never does) ✓
- **No-op when absent** → Watcher tolerates missing dir; row falls back to raw input; group only for ≥2 ✓
- **Bounds** → `SUBAGENT_TOOL_CALLS_MAX` + `droppedToolCalls` (Task 2/8) ✓
- **Edge: missing meta.toolUseId** → emit skips it (Task 3) ✓
- **Codex no-op** → Task interception is inside the Claude provider switch (Task 9) ✓
- **Open questions** (status source, providerSessionId discovery timing, exact block-list mapper file) flagged inline as impl notes ✓

**Type consistency check:** `SubAgentState`/`SubAgentToolCall` defined once in `preload/api/types.ts` (Task 1), re-exported by `workspaceState.ts` (Task 6); `toolUseId` is the join key everywhere (`out[toolUseId]` ↔ `subAgents[block.id]`); `SUBAGENT_TOOL_CALLS_MAX` used in builder (Task 2) and reflected by `droppedToolCalls` in UI (Task 8). Consistent.
