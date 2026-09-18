# Agent Goal Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the harness-owned goal loop (#1001): MCP tools `goal_loop_start`/`goal_loop_complete`, a main-process loop service that re-prompts on idle until the goal is complete, and a renderer control surface.

**Architecture:** Single mechanism, no provider hooks (research in `docs/superpowers/specs/2026-09-18-goal-loop-design.md`): a `GoalLoopService` in main subscribes to `SessionManager` semantic events, uses `reduceWorkingState` to detect working→idle, and delivers the agent-written continuation prompt via `deliverPromptToAgent`. State is durable in `GoalLoopStore`; the renderer gets a status strip + control overlay through IPC.

**Tech Stack:** Electron main + React renderer, `@modelcontextprotocol/sdk`, zod, zustand, vitest.

**Worktree:** `.worktrees/agent-goal-loop`, branch `feat/agent-goal-loop`. Baseline verified (typecheck clean; `src/main/tldr src/main/agentActivity src/main/orchestration` suites 63/63).

**Conventions:** Conventional Commits per task with `Refs #1001`. WHY comments per AGENTS.md. Run `npx vitest run <paths>` scoped; `npm run typecheck` after main-wiring tasks.

---

### Task 1: Shared contract types + domain registration

**Files:**
- Create: `src/shared/types/goalLoop.ts`
- Modify: `src/mcp/shared/types.ts` (three domain lists + Claude allowlist)

- [ ] **Step 1: Write `src/shared/types/goalLoop.ts`**

```ts
// The loop's contract types live in shared/ because three processes touch
// them: main owns the service, the MCP runtime validates tool input, and the
// renderer renders snapshots. A Goal Loop is keyed by SESSION id (not the
// tldrIdentity the goal/tldr stores use) because the loop's only actuator is
// `deliverPromptToAgent(sessionId, ...)`: a conversation that survives a
// reload keeps working, but a session that is gone cannot be prompted, and
// the spec pauses the loop on provider switch anyway.
export const GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS = 25
export const GOAL_LOOP_MAX_CONTINUATIONS_CEILING = 200
export const GOAL_LOOP_MAX_GOAL_CHARACTERS = 800
export const GOAL_LOOP_MAX_PROMPT_CHARACTERS = 4000
export const GOAL_LOOP_MAX_SUMMARY_CHARACTERS = 2000

export type GoalLoopPhase = 'active' | 'paused' | 'ended'
export type GoalLoopPauseReason = 'cap' | 'error' | 'user' | 'interrupted'
export type GoalLoopEndReason = 'done' | 'blocked' | 'cancelled'

export type GoalLoopState = {
  sessionId: string
  goal: string
  loopPrompt: string
  phase: GoalLoopPhase
  pauseReason: GoalLoopPauseReason | null
  endReason: GoalLoopEndReason | null
  completionSummary: string | null
  maxContinuations: number
  continuationsDelivered: number
  consecutiveDeliveryFailures: number
  startedAt: string
  updatedAt: string
}

export const GOAL_LOOP_INSTRUCTIONS = `When Goal Loop MCP is available in this session, use goal_loop_start only when the user explicitly asks you to run a loop, keep going, or work autonomously toward an outcome. Write loopPrompt yourself as a complete, self-contained instruction: it is re-sent to you every time you stop before the goal is done, so it must restate the goal and tell you to reassess remaining work and continue from where you left off. Optionally pass maxContinuations (default 25) when the user asks for a different budget.

Call goal_loop_complete only when the goal is completely and utterly satisfied — every requirement verified, nothing merely started or promised. Never call it to escape difficulty or uncertainty; if you genuinely need the user (missing input, impossible constraint), call it with outcome "blocked" and say exactly what you need. While a loop is active, keep working toward the goal on every continuation instead of asking whether to continue.

Only control your own session's loop through the available tools. If this session has no Goal Loop MCP capability, this skill is inactive: do not try to create files, contact another session, or invent a substitute tool.`
```

- [ ] **Step 2: Register the domain in `src/mcp/shared/types.ts`**

Add `'goal_loop'` to: the `BuiltInMcpDomain` union (after `'goal'`), `BUILT_IN_MCP_DOMAINS`, `CONFIGURABLE_BUILT_IN_MCP_DOMAINS` (between `'goal'` and `'orchestration'`), and the `claude:` array in `BUILT_IN_MCP_DOMAINS_BY_PROVIDER` (after `'goal'`). Codex/OpenCode spread `BUILT_IN_MCP_DOMAINS` and pick it up automatically. Add a WHY line on the union: goal_loop is harness-driven, so unlike `workflows` it is safe on Claude.

- [ ] **Step 3: Failing test — create `src/mcp/shared/types.goalLoop.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { BUILT_IN_MCP_DOMAINS, CONFIGURABLE_BUILT_IN_MCP_DOMAINS, providerSupportsBuiltInMcpDomain } from './types.js'

describe('goal_loop domain registration', () => {
  it('is a built-in, configurable domain on every provider', () => {
    expect(BUILT_IN_MCP_DOMAINS).toContain('goal_loop')
    expect(CONFIGURABLE_BUILT_IN_MCP_DOMAINS).toContain('goal_loop')
    for (const provider of ['claude', 'codex', 'opencode'] as const) {
      expect(providerSupportsBuiltInMcpDomain(provider, 'goal_loop')).toBe(true)
    }
  })
})
```

- [ ] **Step 4: Run** `npx vitest run src/mcp/shared/types.goalLoop.test.ts` — expect PASS after Step 2 (write test first, watch it fail, then register).

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(goal-loop): register the goal_loop built-in MCP domain - Refs #1001"`

---

### Task 2: Continuation prompt builder

**Files:**
- Create: `src/mcp/shared/goalLoopPrompt.ts`
- Test: `src/mcp/shared/goalLoopPrompt.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest'
import { buildGoalLoopContinuationPrompt } from './goalLoopPrompt.js'

describe('buildGoalLoopContinuationPrompt', () => {
  it('frames the agent-written instruction with the loop contract and budget', () => {
    const prompt = buildGoalLoopContinuationPrompt({
      goal: 'Migrate tests to Vitest.', loopPrompt: '  Keep migrating test files.  ', iteration: 3, maxContinuations: 25,
    })
    expect(prompt).toContain('<goal-loop-continuation>')
    expect(prompt).toContain('continuation 3 of 25')
    expect(prompt).toContain('Goal: Migrate tests to Vitest.')
    expect(prompt).toContain('goal_loop_complete')
    expect(prompt).toContain('<loop-instruction>\nKeep migrating test files.</loop-instruction>')
  })
})
```

- [ ] **Step 2: Run** — expect FAIL (module missing).

- [ ] **Step 3: Implement `src/mcp/shared/goalLoopPrompt.ts`**

```ts
export type GoalLoopContinuationPromptOptions = {
  goal: string
  loopPrompt: string
  iteration: number
  maxContinuations: number
}

/** WHY a user-visible prompt rather than hidden state: the loop's only
 * cross-provider instruction channel is the text we submit (same reasoning as
 * buildOrchestrationBootstrapPrompt). The header carries what changes per
 * iteration; the agent-written loopPrompt stays verbatim so the loop's own
 * contract cannot drift between continuations. */
export function buildGoalLoopContinuationPrompt({
  goal, loopPrompt, iteration, maxContinuations,
}: GoalLoopContinuationPromptOptions): string {
  return [
    '<goal-loop-continuation>',
    `Agent Code goal loop, continuation ${iteration} of ${maxContinuations}.`,
    `Goal: ${goal.trim()}`,
    'You stopped before this goal was complete. Reassess what remains, then keep working.',
    'Call goal_loop_complete with outcome "done" ONLY when the goal is completely and utterly satisfied; call it with outcome "blocked" if you need the user. Otherwise continue working.',
    '</goal-loop-continuation>',
    '',
    '<loop-instruction>',
    loopPrompt.trim(),
    '</loop-instruction>',
  ].join('\n')
}
```

- [ ] **Step 4: Run** — expect PASS. **Step 5: Commit** `feat(goal-loop): add the continuation prompt builder - Refs #1001`

---

### Task 3: GoalLoopStore (durable state)

**Files:**
- Create: `src/main/goalLoop/GoalLoopStore.ts`
- Test: `src/main/goalLoop/GoalLoopStore.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GoalLoopState } from '@shared/types/goalLoop.js'
import { GoalLoopStore } from './GoalLoopStore.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))) })
async function store(): Promise<{ store: GoalLoopStore; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
  directories.push(directory)
  const file = join(directory, 'goal-loop.json')
  return { store: new GoalLoopStore(file), file }
}
const loop = (overrides: Partial<GoalLoopState> = {}): GoalLoopState => ({
  sessionId: 's1', goal: 'Ship it.', loopPrompt: 'Keep shipping.', phase: 'active',
  pauseReason: null, endReason: null, completionSummary: null,
  maxContinuations: 25, continuationsDelivered: 0, consecutiveDeliveryFailures: 0,
  startedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z',
  ...overrides,
})

describe('GoalLoopStore', () => {
  it('round-trips states atomically and restores them after restart', async () => {
    const { store, file } = await store()
    await store.write({ s1: loop() })
    const restored = await new GoalLoopStore(file).read()
    expect(restored['s1']).toEqual(loop())
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1)
  })
  it('returns an empty map for a missing file', async () => {
    const { store } = await store()
    expect(await store.read()).toEqual({})
  })
  it('preserves malformed storage instead of resetting it', async () => {
    const { store, file } = await store()
    await writeFile(file, '{broken')
    await expect(store.read()).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe('{broken')
  })
  it('rejects structurally invalid entries', async () => {
    const { store, file } = await store()
    await writeFile(file, JSON.stringify({ version: 1, loops: { s1: { phase: 'zooming' } } }))
    await expect(store.read()).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**

```ts
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import type { GoalLoopState } from '@shared/types/goalLoop.js'

const MAX_FILE_BYTES = 8 * 1024 * 1024
export const GOAL_LOOP_STORE_LIMIT = 200

const PHASES = new Set(['active', 'paused', 'ended'])
const PAUSE_REASONS = new Set(['cap', 'error', 'user', 'interrupted'])
const END_REASONS = new Set(['done', 'blocked', 'cancelled'])

function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validLoop(raw: unknown): raw is GoalLoopState {
  const loop = raw as GoalLoopState
  return Boolean(loop) && typeof loop.sessionId === 'string' && loop.sessionId.length > 0
    && typeof loop.goal === 'string' && typeof loop.loopPrompt === 'string'
    && typeof loop.phase === 'string' && PHASES.has(loop.phase)
    && (loop.pauseReason === null || (typeof loop.pauseReason === 'string' && PAUSE_REASONS.has(loop.pauseReason)))
    && (loop.endReason === null || (typeof loop.endReason === 'string' && END_REASONS.has(loop.endReason)))
    && (loop.completionSummary === null || typeof loop.completionSummary === 'string')
    && Number.isSafeInteger(loop.maxContinuations) && loop.maxContinuations >= 1
    && Number.isSafeInteger(loop.continuationsDelivered) && loop.continuationsDelivered >= 0
    && Number.isSafeInteger(loop.consecutiveDeliveryFailures) && loop.consecutiveDeliveryFailures >= 0
    && iso(loop.startedAt) && iso(loop.updatedAt)
}

/** WHY a whole-file atomic rewrite instead of TldrStore's per-identity files:
 * at most one loop exists per session and the service rewrites on every state
 * change, so the document stays tiny; per-identity files would add eviction
 * machinery for a map that the service already bounds (ended loops beyond
 * GOAL_LOOP_STORE_LIMIT are dropped before writing). Corrupt storage is
 * preserved on disk, mirroring TldrStore's never-silently-reset contract. */
export class GoalLoopStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  read(): Promise<Record<string, GoalLoopState>> {
    return this.serialize(async () => {
      let source: string
      try {
        if ((await stat(this.file)).size > MAX_FILE_BYTES) throw new Error('Goal Loop storage exceeds its size limit.')
        source = await readFile(this.file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return {}
      }
      const document = JSON.parse(source)
      const loops: unknown = document?.loops
      if (document?.version !== 1 || !loops || typeof loops !== 'object' || Array.isArray(loops)
        || Object.keys(loops).length > GOAL_LOOP_STORE_LIMIT
        || !Object.values(loops).every(validLoop)) {
        throw new Error('Goal Loop storage is invalid; the original file has been preserved.')
      }
      return loops as Record<string, GoalLoopState>
    })
  }

  async write(states: Record<string, GoalLoopState>): Promise<void> {
    return this.serialize(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`
      await mkdir(dirname(this.file), { recursive: true })
      try {
        await writeFile(temporary, JSON.stringify({ version: 1, loops: states }), { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.file)
      } finally {
        await unlink(temporary).catch(() => {})
      }
    })
  }
}

// EventEmitter import retained for future 'changed' broadcasts; the service
// owns eventing today, so the store stays a dumb durable map.
void EventEmitter
```

(Remove the `void EventEmitter` + its import if lint complains — they exist to document the deliberate difference from TldrStore.)

- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat(goal-loop): add durable GoalLoopStore - Refs #1001`

---

### Task 4: GoalLoopService (the loop state machine)

**Files:**
- Create: `src/main/goalLoop/GoalLoopService.ts`
- Test: `src/main/goalLoop/GoalLoopService.test.ts`

- [ ] **Step 1: Failing test** (fake manager = EventEmitter + delivery mock)

```ts
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildGoalLoopContinuationPrompt } from '@mcp/shared/goalLoopPrompt.js'
import { GoalLoopService } from './GoalLoopService.js'
import { GoalLoopStore } from './GoalLoopStore.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))) })

type FakeManager = EventEmitter & { deliverPromptToAgent: ReturnType<typeof vi.fn> }
async function service(deliver: FakeManager['deliverPromptToAgent'] = vi.fn(async () => ({ ok: true }))) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
  directories.push(directory)
  const manager = Object.assign(new EventEmitter(), { deliverPromptToAgent: deliver }) as FakeManager
  const svc = new GoalLoopService({ manager, store: new GoalLoopStore(join(directory, 'goal-loop.json')), now: () => new Date('2026-09-18T00:00:00.000Z') })
  await svc.start()
  return { svc, manager, deliver }
}
const idleTurn = (manager: FakeManager) => manager.emit('semantic-event', { sessionId: 's1', event: { type: 'turn_completed' } })

describe('GoalLoopService', () => {
  it('delivers the continuation prompt when the session goes idle without completion', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'Migrate tests.', loopPrompt: 'Keep migrating.' })
    idleTurn(manager)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    expect(deliver).toHaveBeenCalledWith('s1', buildGoalLoopContinuationPrompt({
      goal: 'Migrate tests.', loopPrompt: 'Keep migrating.', iteration: 1, maxContinuations: 25,
    }), undefined, undefined, undefined)
    expect(svc.snapshot()['s1']?.continuationsDelivered).toBe(1)
  })
  it('does not continue while tools are pending (awaiting-tool)', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'stream_phase', phase: 'awaiting-tool', toolUseId: 't1' } })
    idleTurn(manager)
    expect(deliver).not.toHaveBeenCalled()
  })
  it('ends on complete and never delivers again', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    await svc.complete('s1', 'done', 'All requirements verified.')
    idleTurn(manager)
    expect(deliver).not.toHaveBeenCalled()
    expect(svc.snapshot()['s1']).toMatchObject({ phase: 'ended', endReason: 'done' })
  })
  it('pauses at the cap instead of hard-killing, and resume+raise continues', async () => {
    const { svc, manager, deliver } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.', maxContinuations: 1 })
    idleTurn(manager)
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
    idleTurn(manager)
    await vi.waitFor(() => expect(svc.snapshot()['s1']?.phase).toBe('paused'))
    expect(svc.snapshot()['s1']?.pauseReason).toBe('cap')
    expect(deliver).toHaveBeenCalledTimes(1)
    svc.control('s1', { action: 'raise-cap', value: 2 })
    svc.control('s1', { action: 'resume' })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
  })
  it('pauses after repeated delivery failures', async () => {
    const deliver = vi.fn(async () => ({ ok: false, retrySafe: true }))
    const { svc, manager } = await service(deliver)
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    idleTurn(manager); await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2))
    idleTurn(manager); await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(4))
    idleTurn(manager)
    await vi.waitFor(() => expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'error' }))
  })
  it('marks an active loop interrupted when the session is removed', async () => {
    const { svc, manager } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    manager.emit('removed', { sessionId: 's1' })
    expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'interrupted' })
  })
  it('recovers persisted active loops as interrupted on start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
    directories.push(directory)
    await new GoalLoopStore(join(directory, 'goal-loop.json')).write({ s1: {
      sessionId: 's1', goal: 'G.', loopPrompt: 'P.', phase: 'active', pauseReason: null, endReason: null,
      completionSummary: null, maxContinuations: 25, continuationsDelivered: 2,
      consecutiveDeliveryFailures: 0, startedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z',
    } })
    const manager = Object.assign(new EventEmitter(), { deliverPromptToAgent: vi.fn() })
    const svc = new GoalLoopService({ manager, store: new GoalLoopStore(join(directory, 'goal-loop.json')) })
    await svc.start()
    expect(svc.snapshot()['s1']).toMatchObject({ phase: 'paused', pauseReason: 'interrupted' })
  })
  it('rejects a second concurrent loop and a complete with no loop', async () => {
    const { svc } = await service()
    await svc.startLoop('s1', { goal: 'G.', loopPrompt: 'P.' })
    await expect(svc.startLoop('s1', { goal: 'G2.', loopPrompt: 'P.' })).rejects.toThrow('already')
    await expect(svc.complete('other', 'done', 'x.')).rejects.toThrow('No goal loop')
  })
})
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement `src/main/goalLoop/GoalLoopService.ts`**

```ts
import { EventEmitter } from 'node:events'
import type { SessionManager } from '@main/sessionManager.js'
import { buildGoalLoopContinuationPrompt } from '@mcp/shared/goalLoopPrompt.js'
import { INITIAL_WORKING_STATE, isWorking, reduceWorkingState } from '@shared/agentActivity/workingState.js'
import type { WorkingState } from '@shared/agentActivity/workingState.js'
import type { GoalLoopState } from '@shared/types/goalLoop.js'
import { GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS, GOAL_LOOP_MAX_CONTINUATIONS_CEILING } from '@shared/types/goalLoop.js'
import { GOAL_LOOP_STORE_LIMIT, GoalLoopStore } from './GoalLoopStore.js'

const MAX_DELIVERY_FAILURES = 3

type GoalLoopManagerPort = Pick<SessionManager, 'on'> & {
  deliverPromptToAgent: SessionManager['deliverPromptToAgent']
}

/** The harness-owned goal loop (#1001).
 *
 * WHY main-process and not a provider Stop hook: Claude Code force-stops
 * after 9 consecutive Stop-hook blocks, so hook-driven persistence modes die
 * young (oh-my-claudecode #3138), and OpenCode has no block-capable Stop hook
 * at all. We own deliverPromptToAgent and observe every turn boundary here,
 * so the loop is provider-agnostic and unbounded by provider overrides.
 *
 * WHY attention/conditions are NOT subscribed: a permission prompt parks the
 * agent on the USER's decision; delivering a continuation behind that dialog
 * would queue a prompt the user never saw. The loop continues only after a
 * semantic working→idle transition.
 *
 * Re-entrancy: delivery is awaited, so a second turn_completed during the
 * await is dropped via `continuing`; deliverPromptToAgent's own in-flight
 * mutual exclusion is the second gate.
 */
export class GoalLoopService extends EventEmitter {
  private readonly loops = new Map<string, GoalLoopState>()
  private readonly working = new Map<string, WorkingState>()
  private readonly continuing = new Set<string>()

  constructor(private readonly deps: {
    manager: GoalLoopManagerPort
    store: GoalLoopStore
    now?: () => Date
  }) { super() }

  async start(): Promise<void> {
    const persisted = await this.deps.store.read().catch(error => {
      console.warn('[goal-loop] persisted state unreadable; starting empty:', error)
      return {}
    })
    const now = this.now().toISOString()
    for (const [sessionId, loop] of Object.entries(persisted)) {
      // An app restart severed the observation the loop depends on; never
      // blind-continue a loop the user did not re-arm (spec: conservative v1).
      this.loops.set(sessionId, loop.phase === 'active'
        ? { ...loop, phase: 'paused', pauseReason: 'interrupted', updatedAt: now }
        : loop)
    }
    const { manager } = this.deps
    manager.on('semantic-event', ({ sessionId, event }: { sessionId: string; event: unknown }) => {
      this.signal(sessionId, event)
    })
    // `removed` is the reliable end (forwarder.ts); `exit` can precede it.
    manager.on('removed', ({ sessionId }: { sessionId: string }) => this.interrupt(sessionId))
    manager.on('exit', ({ sessionId }: { sessionId: string }) => this.interrupt(sessionId))
    await this.persist()
  }

  snapshot(): Record<string, GoalLoopState> {
    return Object.fromEntries([...this.loops.entries()].map(([id, loop]) => [id, { ...loop }]))
  }

  async startLoop(sessionId: string, input: { goal: string; loopPrompt: string; maxContinuations?: number }): Promise<GoalLoopState> {
    const existing = this.loops.get(sessionId)
    if (existing && existing.phase !== 'ended') throw new Error('A goal loop is already active for this session. Complete or stop it first.')
    const now = this.now().toISOString()
    const loop: GoalLoopState = {
      sessionId, goal: input.goal.trim(), loopPrompt: input.loopPrompt.trim(),
      phase: 'active', pauseReason: null, endReason: null, completionSummary: null,
      maxContinuations: Math.min(input.maxContinuations ?? GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS, GOAL_LOOP_MAX_CONTINUATIONS_CEILING),
      continuationsDelivered: 0, consecutiveDeliveryFailures: 0, startedAt: now, updatedAt: now,
    }
    this.loops.set(sessionId, loop)
    // Seed as working: goal_loop_start is a tool call INSIDE the running turn,
    // so the first turn_completed must land on a responding state or the
    // working→idle transition that triggers continuation #1 never fires.
    this.working.set(sessionId, { ...INITIAL_WORKING_STATE, phase: 'responding' })
    await this.persist()
    return { ...loop }
  }

  async complete(sessionId: string, outcome: 'done' | 'blocked', summary: string): Promise<GoalLoopState> {
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase === 'ended') throw new Error('No goal loop is active for this session.')
    const ended: GoalLoopState = {
      ...loop, phase: 'ended', endReason: outcome, completionSummary: summary.trim(),
      pauseReason: null, updatedAt: this.now().toISOString(),
    }
    this.loops.set(sessionId, ended)
    await this.persist()
    return { ...ended }
  }

  control(sessionId: string, command: { action: 'pause' | 'resume' | 'stop' | 'raise-cap'; value?: number }): GoalLoopState | null {
    const loop = this.loops.get(sessionId)
    if (!loop) return null
    const now = this.now().toISOString()
    if (command.action === 'pause' && loop.phase === 'active') {
      this.loops.set(sessionId, { ...loop, phase: 'paused', pauseReason: 'user', updatedAt: now })
    } else if (command.action === 'stop' && loop.phase !== 'ended') {
      this.loops.set(sessionId, { ...loop, phase: 'ended', endReason: 'cancelled', pauseReason: null, updatedAt: now })
    } else if (command.action === 'raise-cap') {
      const raised = Math.min(command.value ?? loop.maxContinuations, GOAL_LOOP_MAX_CONTINUATIONS_CEILING)
      this.loops.set(sessionId, { ...loop, maxContinuations: Math.max(loop.maxContinuations, raised), updatedAt: now })
    } else if (command.action === 'resume' && loop.phase === 'paused') {
      this.loops.set(sessionId, { ...loop, phase: 'active', pauseReason: null, updatedAt: now })
      // Resuming an already-idle agent must not wait for a turn_completed
      // that already happened — deliver the next continuation now.
      const state = this.working.get(sessionId)
      if (!state || !isWorking(state)) void this.maybeContinue(sessionId)
    }
    const next = this.loops.get(sessionId)!
    void this.persist()
    return { ...next }
  }

  private now(): Date { return this.deps.now?.() ?? new Date() }

  private signal(sessionId: string, event: unknown): void {
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase !== 'active') return
    const state = this.working.get(sessionId) ?? INITIAL_WORKING_STATE
    const wasWorking = isWorking(state)
    const next = reduceWorkingState(state, { type: 'semantic', event })
    this.working.set(sessionId, next)
    if (wasWorking && !isWorking(next)) void this.maybeContinue(sessionId)
  }

  private interrupt(sessionId: string): void {
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase !== 'active') return
    this.loops.set(sessionId, { ...loop, phase: 'paused', pauseReason: 'interrupted', updatedAt: this.now().toISOString() })
    this.working.delete(sessionId)
    void this.persist()
  }

  private async maybeContinue(sessionId: string): Promise<void> {
    const loop = this.loops.get(sessionId)
    if (!loop || loop.phase !== 'active' || this.continuing.has(sessionId)) return
    this.continuing.add(sessionId)
    try {
      // The cap pauses BEFORE delivering past the budget: a confused agent
      // must not get one free continuation beyond what the user armed.
      if (loop.continuationsDelivered >= loop.maxContinuations) {
        this.loops.set(sessionId, { ...loop, phase: 'paused', pauseReason: 'cap', updatedAt: this.now().toISOString() })
        await this.persist()
        return
      }
      const prompt = buildGoalLoopContinuationPrompt({
        goal: loop.goal, loopPrompt: loop.loopPrompt,
        iteration: loop.continuationsDelivered + 1, maxContinuations: loop.maxContinuations,
      })
      let result = await this.deps.manager.deliverPromptToAgent(sessionId, prompt)
      if (!result.ok && result.retrySafe) result = await this.deps.manager.deliverPromptToAgent(sessionId, prompt)
      const current = this.loops.get(sessionId)
      if (!current || current.phase !== 'active') return
      if (result.ok) {
        this.loops.set(sessionId, {
          ...current, continuationsDelivered: current.continuationsDelivered + 1,
          consecutiveDeliveryFailures: 0, updatedAt: this.now().toISOString(),
        })
      } else {
        const failures = current.consecutiveDeliveryFailures + 1
        this.loops.set(sessionId, {
          ...current, consecutiveDeliveryFailures: failures,
          ...(failures >= MAX_DELIVERY_FAILURES ? { phase: 'paused' as const, pauseReason: 'error' as const } : {}),
          updatedAt: this.now().toISOString(),
        })
      }
      await this.persist()
    } catch (error) {
      console.warn('[goal-loop] continuation failed unexpectedly:', error)
    } finally {
      this.continuing.delete(sessionId)
    }
  }

  private async persist(): Promise<void> {
    // Bound the file: ended loops are history, newest wins; live loops are
    // never evicted — if they exceed the cap the write fails loudly instead.
    const entries = [...this.loops.entries()]
    const live = entries.filter(([, loop]) => loop.phase !== 'ended')
    const ended = entries.filter(([, loop]) => loop.phase === 'ended')
    const kept = [...live, ...ended.slice(-GOAL_LOOP_STORE_LIMIT)].slice(0, GOAL_LOOP_STORE_LIMIT)
    this.loops.clear()
    for (const [id, loop] of kept) this.loops.set(id, loop)
    try {
      await this.deps.store.write(this.snapshot())
    } catch (error) {
      console.warn('[goal-loop] persisting loop state failed:', error)
    }
    this.emit('changed')
  }
}
```

- [ ] **Step 4: Run** — PASS (all 8 tests). **Step 5: Commit** `feat(goal-loop): add the harness-owned loop service - Refs #1001`

---

### Task 5: MCP tools + system test

**Files:**
- Modify: `src/mcp/runtime/BuiltInMcpHttpHost.ts` (deps type)
- Modify: `src/mcp/runtime/createBuiltInMcpServer.ts` (tools + instructions)
- Test: `src/main/goalLoop/goalLoop.system.test.ts`

- [ ] **Step 1: Failing system test**

```ts
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createBuiltInMcpServer } from '@mcp/runtime/createBuiltInMcpServer.js'
import { GOAL_LOOP_INSTRUCTIONS } from '@shared/types/goalLoop.js'
import { GoalLoopService } from './GoalLoopService.js'
import { GoalLoopStore } from './GoalLoopStore.js'

vi.mock('@main/performance/PerformanceService.js', () => ({ performanceService: { record: vi.fn() } }))

const directories: string[] = []
const clients: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup(sessionId: string) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-code-goal-loop-'))
  directories.push(directory)
  const manager = Object.assign(new EventEmitter(), { deliverPromptToAgent: vi.fn(async () => ({ ok: true })) })
  const service = new GoalLoopService({ manager, store: new GoalLoopStore(join(directory, 'goal-loop.json')) })
  await service.start()
  const server = createBuiltInMcpServer({ sessionId, cwd: '/project', domains: ['goal_loop'] }, { goalLoopService: service })
  const client = new Client({ name: 'goal-loop-test', version: '1' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  clients.push(client, server)
  return { client, service, manager }
}

describe('Goal Loop MCP', () => {
  it('starts, continues on idle, and completes over the real tool surface', async () => {
    const { client, manager } = await setup('s1')
    const tools = (await client.listTools()).tools
    expect(tools.map(tool => tool.name).sort()).toEqual(['goal_loop_complete', 'goal_loop_start'])
    expect(client.getInstructions()).toContain(GOAL_LOOP_INSTRUCTIONS)
    const started = await client.callTool({ name: 'goal_loop_start', arguments: { goal: 'Migrate tests.', loopPrompt: 'Keep migrating.' } })
    expect(started.isError).not.toBe(true)
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'turn_completed' } })
    await vi.waitFor(() => expect(manager.deliverPromptToAgent).toHaveBeenCalledTimes(1))
    const completed = await client.callTool({ name: 'goal_loop_complete', arguments: { outcome: 'done', summary: 'Every test migrated and passing.' } })
    expect(completed.isError).not.toBe(true)
    manager.emit('semantic-event', { sessionId: 's1', event: { type: 'turn_completed' } })
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(manager.deliverPromptToAgent).toHaveBeenCalledTimes(1)
  })
  it('rejects complete from a session with no loop and validates input', async () => {
    const { client } = await setup('s2')
    expect((await client.callTool({ name: 'goal_loop_complete', arguments: { outcome: 'done', summary: 'Nothing to complete.' } })).isError).toBe(true)
    expect((await client.callTool({ name: 'goal_loop_start', arguments: { goal: '', loopPrompt: 'P.' } })).isError).toBe(true)
    expect((await client.callTool({ name: 'goal_loop_start', arguments: { goal: 'G.', loopPrompt: 'P.', maxContinuations: 999 } })).isError).toBe(true)
  })
})
```

- [ ] **Step 2: Run** — FAIL (no tools registered).

- [ ] **Step 3: Extend `BuiltInMcpDependencies`** in `BuiltInMcpHttpHost.ts`:

```ts
  goalLoopService?: Pick<GoalLoopService, 'startLoop' | 'complete'>
```

with `import type { GoalLoopService } from '@main/goalLoop/GoalLoopService.js'` (follow the file's existing import-group style).

- [ ] **Step 4: Register tools + instructions in `createBuiltInMcpServer.ts`**

Import `GOAL_LOOP_INSTRUCTIONS`, `GOAL_LOOP_MAX_CONTINUATIONS_CEILING`, `GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS`, `GOAL_LOOP_MAX_GOAL_CHARACTERS`, `GOAL_LOOP_MAX_PROMPT_CHARACTERS`, `GOAL_LOOP_MAX_SUMMARY_CHARACTERS` from `@shared/types/goalLoop.js` and add after the `goal` block:

```ts
  if (scope.domains.includes('goal_loop')) {
    registerGoalLoopTools(server, scope, dependencies)
  }
```

and:

```ts
function registerGoalLoopTools(
  server: McpServer,
  scope: McpSessionScope,
  dependencies: BuiltInMcpDependencies,
): void {
  const service = dependencies.goalLoopService
  const failure = (error: unknown) => ({
    ...toolText({ ok: false, message: error instanceof Error ? error.message : 'Goal Loop call failed.' }),
    isError: true,
  })
  server.registerTool('goal_loop_start', {
    title: 'Start goal loop',
    description: `Start a harness-owned loop that keeps re-prompting this session until the goal is completely done. Write loopPrompt yourself as a self-contained continuation instruction; it is re-sent every time you stop. Call goal_loop_complete only when utterly done, or with outcome "blocked" when you need the user. Budget defaults to ${GOAL_LOOP_DEFAULT_MAX_CONTINUATIONS} continuations.`,
    inputSchema: {
      goal: z.string().min(1).max(GOAL_LOOP_MAX_GOAL_CHARACTERS),
      loopPrompt: z.string().min(1).max(GOAL_LOOP_MAX_PROMPT_CHARACTERS),
      maxContinuations: z.number().int().min(1).max(GOAL_LOOP_MAX_CONTINUATIONS_CEILING).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ goal, loopPrompt, maxContinuations }) => {
    try {
      if (!service) throw new Error('Goal Loop is unavailable.')
      return toolText({ ok: true, loop: await service.startLoop(scope.sessionId, { goal, loopPrompt, maxContinuations }) })
    } catch (error) { return failure(error) }
  })
  server.registerTool('goal_loop_complete', {
    title: 'Complete goal loop',
    description: 'End this session\'s goal loop. Call with outcome "done" ONLY when the goal is completely and utterly satisfied and verified — never to exit early. Call with outcome "blocked" when you genuinely need the user, and say exactly what you need in the summary.',
    inputSchema: {
      outcome: z.enum(['done', 'blocked']),
      summary: z.string().min(1).max(GOAL_LOOP_MAX_SUMMARY_CHARACTERS),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ outcome, summary }) => {
    try {
      if (!service) throw new Error('Goal Loop is unavailable.')
      return toolText({ ok: true, loop: await service.complete(scope.sessionId, outcome, summary) })
    } catch (error) { return failure(error) }
  })
}
```

Add to `builtInInstructions`: `...(scope.domains.includes('goal_loop') ? [GOAL_LOOP_INSTRUCTIONS] : []),`

- [ ] **Step 5: Run** `npx vitest run src/main/goalLoop` — PASS. Also rerun `src/main/tldr/TldrStore.system.test.ts` (instruction-order coupling risk).

- [ ] **Step 6: Commit** `feat(goal-loop): expose goal_loop_start and goal_loop_complete over MCP - Refs #1001`

---

### Task 6: Main wiring + renderer IPC

**Files:**
- Create: `src/main/goalLoop/ipc.ts`
- Modify: `src/main/index.ts` (construct + register, near `registerGoalIpc` at line ~1007 and `setDependencies` at ~1008)
- Create: `src/preload/api/goalLoop.ts`
- Modify: `src/preload/api/index.ts`

- [ ] **Step 1: `src/main/goalLoop/ipc.ts`** (mirror `src/main/tldr/ipc.ts`; renderer APIs may control but only for loops that exist — the service is the authority)

```ts
import { ipcMain } from 'electron'
import { z } from 'zod'
import { broadcastToWindows, getBrowserWindow, windowIdFor } from '@main/window/windowRegistry.js'
import type { GoalLoopService } from './GoalLoopService.js'

const sessionIdList = z.array(z.string().min(1)).max(10_000)
const controlRequest = z.object({
  sessionId: z.string().min(1),
  action: z.enum(['pause', 'resume', 'stop', 'raise-cap']),
  value: z.number().int().min(1).max(200).optional(),
})

function assertApplicationWindow(event: Electron.IpcMainInvokeEvent): void {
  const windowId = windowIdFor(event.sender)
  if (!windowId || !getBrowserWindow(windowId) || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Goal Loop requires a registered application window.')
  }
}

export function registerGoalLoopIpc(service: GoalLoopService): void {
  ipcMain.handle('goal-loop:read', (event, raw: unknown) => {
    assertApplicationWindow(event)
    const ids = new Set(sessionIdList.parse(raw))
    return Object.fromEntries(Object.entries(service.snapshot()).filter(([id]) => ids.has(id)))
  })
  // The renderer may steer (pause/resume/stop/raise) any loop it can see:
  // creating loops stays MCP-only (the model writes the prompt), but
  // controlling a running loop is exactly the user's modal surface.
  ipcMain.handle('goal-loop:control', (event, raw: unknown) => {
    assertApplicationWindow(event)
    return service.control(controlRequest.parse(raw).sessionId, controlRequest.parse(raw))
  })
  service.on('changed', () => broadcastToWindows('goal-loop:changed'))
}
```

(Refactor the double `controlRequest.parse` into one `const request = controlRequest.parse(raw)` when writing.)

- [ ] **Step 2: Wire in `src/main/index.ts`** — after `registerGoalIpc(goalStore)` (line ~1007):

```ts
  const goalLoopStore = new GoalLoopStore(join(STATE_DIR, 'goal-loop.json'))
  const goalLoopService = new GoalLoopService({ manager, store: goalLoopStore })
  await goalLoopService.start()
  registerGoalLoopIpc(goalLoopService)
```

and add `goalLoopService,` to the `builtInMcpHost.setDependencies({...})` object. Add the imports following the existing alias style (`@main/goalLoop/...`). `GoalLoopService.start()` itself warns-and-continues on unreadable persisted state, matching the sweep pattern above it.

- [ ] **Step 3: `src/preload/api/goalLoop.ts`**

```ts
import { ipcRenderer } from 'electron'
import type { GoalLoopState } from '@shared/types/goalLoop.js'

export const goalLoopApi = {
  readGoalLoops: (sessionIds: string[]): Promise<Record<string, GoalLoopState>> => ipcRenderer.invoke('goal-loop:read', sessionIds),
  controlGoalLoop: (request: { sessionId: string; action: 'pause' | 'resume' | 'stop' | 'raise-cap'; value?: number }): Promise<GoalLoopState | null> => ipcRenderer.invoke('goal-loop:control', request),
  onGoalLoopChanged: (listener: () => void): (() => void) => {
    const handler = () => listener()
    ipcRenderer.on('goal-loop:changed', handler)
    return () => { ipcRenderer.removeListener('goal-loop:changed', handler) }
  },
}
```

Spread into `src/preload/api/index.ts` next to `...tldrApi,` and add the type to the window api type surface the same way tldr's is exposed.

- [ ] **Step 4: Verify** `npm run typecheck` — clean.

- [ ] **Step 5: Commit** `feat(goal-loop): wire the loop service, IPC and preload surface - Refs #1001`

---

### Task 7: Renderer control surface

**Files:**
- Create: `src/renderer/src/features/goal-loop/viewState.ts`
- Create: `src/renderer/src/features/goal-loop/GoalLoopPane.tsx`
- Create: `src/renderer/src/features/goal-loop/commands.ts`
- Create: `src/renderer/src/features/goal-loop/goalLoop.renderer.test.tsx`
- Modify: `src/renderer/src/workspace/tile-tree/TileTree.tsx` (two TldrPane call sites, lines ~212 and ~246)
- Modify: `src/renderer/src/features/command-palette/catalog.ts` (import + spread)
- Modify: `src/renderer/src/features/command-keybindings/defaults.ts` (after `goal-preview`, line ~301)
- Modify: `src/renderer/src/features/settings/lib/settingsRegistry.ts` (after the `default-goal-mcp` row)

- [ ] **Step 1: `viewState.ts`** — WHY separate from tldr's PreviewKind: that union drives TldrOverlay's identity-keyed data flow; loops are session-keyed with a different lifecycle, and a latch (no hold-peek) matches a surface you act on rather than glance at.

```ts
import { create } from 'zustand'

// Latch only, deliberately: a hold-peek answers "what is the state" but the
// goal loop surface's job is control (pause/resume/raise/stop), which needs
// a stable latch. Not in persisted state for the same reason as the tldr
// preview: a renderer restart must not restore a darkened UI.
export const useGoalLoopView = create<{ latched: boolean }>(() => ({ latched: false }))
export function dismissGoalLoop(): void { useGoalLoopView.setState({ latched: false }) }
export function toggleGoalLoop(): void { useGoalLoopView.setState(state => ({ latched: !state.latched })) }
```

- [ ] **Step 2: `GoalLoopPane.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { GoalLoopState } from '@shared/types/goalLoop'
import { useGoalLoopView } from './viewState'

const PHASE_LABEL: Record<GoalLoopState['phase'], string> = {
  active: 'active', paused: 'paused', ended: 'ended',
}

function describe(loop: GoalLoopState): string {
  const budget = `${loop.continuationsDelivered}/${loop.maxContinuations}`
  if (loop.phase === 'ended') return `ended (${loop.endReason})`
  if (loop.phase === 'paused') return `paused · ${loop.pauseReason} · ${budget}`
  return `iteration ${budget}`
}

/** Mounts inside TldrPane's relative container (TileTree): a slim always-on
 * status strip when a loop exists, and the latched control overlay. The strip
 * is pointer-events-auto over the pane's chrome; the overlay follows
 * TldrOverlay's input discipline (stopPropagation, theme tokens). */
export function GoalLoopPane({ sessionId }: { sessionId: string }) {
  const [loop, setLoop] = useState<GoalLoopState | null>(null)
  const latched = useGoalLoopView(state => state.latched)
  useEffect(() => {
    let current = true
    const read = () => { void window.api.readGoalLoops([sessionId]).then(loops => {
      if (current) setLoop(loops[sessionId] ?? null)
    }).catch(() => {}) }
    const unsubscribe = window.api.onGoalLoopChanged(read)
    read()
    return () => { current = false; unsubscribe() }
  }, [sessionId])
  if (!loop) return null
  const control = (action: 'pause' | 'resume' | 'stop' | 'raise-cap') =>
    () => { void window.api.controlGoalLoop({ sessionId, action, value: action === 'raise-cap' ? loop.maxContinuations + 25 : undefined }) }
  const strip = <div
    data-agent-code-interaction-owner="app"
    data-goal-loop-strip=""
    className="pointer-events-auto absolute inset-x-0 top-0 z-40 flex items-center justify-between gap-2 bg-canvas/90 px-3 py-1 text-xs text-ink"
    onMouseDown={event => event.stopPropagation()}
    onClick={event => event.stopPropagation()}
  >
    <span className="truncate">Goal loop · {PHASE_LABEL[loop.phase]} · {describe(loop)} · {loop.goal}</span>
    <span className="flex shrink-0 gap-2">
      {loop.phase === 'active' && <button type="button" onClick={control('pause')}>Pause</button>}
      {loop.phase === 'paused' && <button type="button" onClick={control('resume')}>Resume</button>}
      {loop.phase === 'paused' && loop.pauseReason === 'cap' && <button type="button" onClick={control('raise-cap')}>Raise cap</button>}
      {loop.phase !== 'ended' && <button type="button" onClick={control('stop')}>Stop</button>}
    </span>
  </div>
  if (!latched) return strip
  return <>
    {strip}
    <div
      data-agent-code-interaction-owner="app"
      data-goal-loop-overlay=""
      role="dialog"
      aria-label="Agent goal loop"
      className="absolute inset-0 z-50 bg-canvas text-ink"
      onMouseDown={event => { event.preventDefault(); event.stopPropagation() }}
      onClick={event => event.stopPropagation()}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 py-16 text-center">
        <p className="text-sm sm:text-base">Goal loop · {PHASE_LABEL[loop.phase]}{loop.phase === 'paused' ? ` · ${loop.pauseReason}` : ''}</p>
        <p className="max-w-xl whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{loop.goal}</p>
        <p className="text-xs">{describe(loop)} continuations · started {loop.startedAt}</p>
        {loop.completionSummary && <p className="max-w-xl text-xs">{loop.endReason}: {loop.completionSummary}</p>}
        <div className="flex gap-3 text-sm">
          {loop.phase === 'active' && <button type="button" onClick={control('pause')}>Pause</button>}
          {loop.phase === 'paused' && <button type="button" onClick={control('resume')}>Resume</button>}
          {loop.phase === 'paused' && loop.pauseReason === 'cap' && <button type="button" onClick={control('raise-cap')}>Raise cap +25</button>}
          {loop.phase !== 'ended' && <button type="button" onClick={control('stop')}>Stop</button>}
        </div>
      </div>
    </div>
  </>
}

export function GoalLoopPaneBoundary({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  return <div className="relative h-full min-h-0 min-w-0">
    {children}
    <GoalLoopPane sessionId={sessionId} />
  </div>
}
```

(Drop `GoalLoopPaneBoundary` if mounting directly inside TldrPane's relative div per Step 4 — keep whichever compiles cleanly at the mount sites.)

- [ ] **Step 3: `commands.ts`**

```ts
import type { CommandDef } from '@renderer/features/command-palette/types'
import { toggle } from '@renderer/features/command-palette/commandState'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { toggleGoalLoop, useGoalLoopView } from './viewState'

export const goalLoopCommands: CommandDef[] = [{
  id: 'goal-loop-preview', title: 'Goal Loop', category: 'navigate', surface: 'app',
  description: '**What it does:** Shows the focused agent’s goal loop — goal, iteration budget and state — with pause, resume, raise-cap and stop controls.\n\n**Use when:** A loop is running and you want to check or steer it without typing.\n\n**Notes:** The strip above the pane is always visible while a loop exists. Loops are started by the agent through Goal Loop MCP; this surface only controls them.',
  keywords: ['goal', 'loop', 'persistence', 'autonomous', 'pause', 'resume', 'stop', 'cap'],
  getState: () => toggle(useGoalLoopView.getState().latched),
  run: ({ ui }) => { ui.closePalette(); toggleGoalLoop() },
}, {
  id: 'goal-loop-stop', title: 'Stop Goal Loop', category: 'session', surface: 'session',
  description: '**What it does:** Ends the focused agent’s active goal loop immediately (ended · cancelled).\n\n**Use when:** The loop should no longer continue.\n\n**Notes:** The agent can still finish its current turn; no further continuations are delivered.',
  keywords: ['goal', 'loop', 'stop', 'cancel', 'end'],
  when: ({ workspace }) => {
    const sessionId = commandTargetSessionId(workspace)
    return Boolean(sessionId && workspace.state.sessions[sessionId])
  },
  run: ({ ui, workspace }) => {
    const sessionId = commandTargetSessionId(workspace)
    if (!sessionId) return
    ui.closePalette()
    void window.api.controlGoalLoop({ sessionId, action: 'stop' })
  },
}]
```

- [ ] **Step 4: Mount.** In `TileTree.tsx`, import `GoalLoopPane` and insert `<GoalLoopPane sessionId={renderedSessionId} />` as the first child inside BOTH `<TldrPane ...>` call sites (~212 and ~246) so it renders inside TldrPane's relative container. In `catalog.ts`, import and spread `goalLoopCommands` beside `tldrCommands`.

- [ ] **Step 5: Keybinding.** In `defaults.ts` after the `goal-preview` entry: `{ commandId: 'goal-loop-preview', bindings: ['Cmd+Shift+G'], context: 'global' },`. Run `npm run check:keybindings` — if it reports a conflict, switch to `Cmd+Shift+L` and re-run until clean; record the final chord in the commit body.

- [ ] **Step 6: Settings row.** Copy the `default-goal-mcp` block in `settingsRegistry.ts` as:

```ts
    {
      id: 'default-goal-loop-mcp',
      category: 'agents',
      title: 'Goal Loop MCP',
      description:
        'Let agents run harness-owned goal loops that keep re-prompting until the goal is complete, with a control strip and Cmd+Shift+G overlay. Off by default. Applies to new agents and existing agents on their next reload. Per-agent overrides take precedence; Use Global MCP Settings clears them.',
      keywords: ['mcp', 'goal', 'loop', 'persistence', 'autonomous', 'default', 'reload', 'existing agents'],
      metadata: { scope: 'app', apply: 'new-session', storage: 'settings' },
      control: {
        type: 'toggle',
        getValue: settings => settings.defaultBuiltInMcpDomains.includes('goal_loop'),
        onToggle: (ctx, value) => updateDefaultBuiltInMcpDomain(ctx, 'goal_loop', value),
      },
    },
```

(Description says "Off by default" matching every sibling row — the domain is *configurable*, not forced on.)

- [ ] **Step 7: Renderer test `goalLoop.renderer.test.tsx`** — follow `tldr.renderer.test.tsx`'s harness (stub `window.api` with `Object.assign(window, { api })`, `@testing-library/react`):

```tsx
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoalLoopState } from '@shared/types/goalLoop'
import { GoalLoopPane } from './GoalLoopPane'
import { dismissGoalLoop, toggleGoalLoop } from './viewState'

const loop = (overrides: Partial<GoalLoopState> = {}): GoalLoopState => ({
  sessionId: 's1', goal: 'Migrate tests.', loopPrompt: 'Keep migrating.', phase: 'active',
  pauseReason: null, endReason: null, completionSummary: null, maxContinuations: 25,
  continuationsDelivered: 3, consecutiveDeliveryFailures: 0,
  startedAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z', ...overrides,
})
const api = {
  readGoalLoops: vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, loop()]))),
  controlGoalLoop: vi.fn(async () => loop()),
  onGoalLoopChanged: vi.fn((listener: () => void) => { return () => {} }),
}
beforeEach(() => { vi.clearAllMocks(); dismissGoalLoop(); Object.assign(window, { api }) })
afterEach(() => { cleanup(); dismissGoalLoop() })

describe('GoalLoopPane', () => {
  it('renders the always-on strip with budget and controls for an active loop', async () => {
    render(<GoalLoopPane sessionId="s1" />)
    expect(await screen.findByText(/iteration 3\/25/)).toBeTruthy()
    screen.getByText('Pause')
    screen.getByText('Stop')
  })
  it('renders nothing without a loop', async () => {
    api.readGoalLoops.mockResolvedValueOnce({})
    const { container } = render(<GoalLoopPane sessionId="s1" />)
    await waitFor(() => expect(api.readGoalLoops).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })
  it('pause calls controlGoalLoop and the latch reveals the overlay', async () => {
    render(<GoalLoopPane sessionId="s1" />)
    screen.getByText('Pause').click()
    expect(api.controlGoalLoop).toHaveBeenCalledWith({ sessionId: 's1', action: 'pause', value: undefined })
    toggleGoalLoop()
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
})
```

- [ ] **Step 8: Run** `npx vitest run src/renderer/src/features/goal-loop` then `npm run typecheck`.

- [ ] **Step 9: Commit** `feat(goal-loop): add the renderer control strip, overlay and commands - Refs #1001`

---

### Task 8: Final verification + PR

- [ ] **Step 1:** `npm run typecheck` — clean.
- [ ] **Step 2:** `npm run check:keybindings` — clean.
- [ ] **Step 3:** `npx vitest run src/main/goalLoop src/main/tldr src/mcp src/renderer/src/features/goal-loop` — all pass.
- [ ] **Step 4:** Full `npm test` — if pre-existing failures appear, verify they exist on `main` too and record them in the PR body; do not fix unrelated failures on this branch.
- [ ] **Step 5:** Review the full diff (`git diff main...HEAD`): no unrelated changes, WHY comments present per AGENTS.md.
- [ ] **Step 6:** Push and open the PR:

```bash
git push -u origin feat/agent-goal-loop
gh pr create --title "feat(goal-loop): harness-owned persistence loop that works until the goal is complete" --body "<problem, behavior, decisions incl. no-provider-hooks rationale and spec refinements (session-keyed loops, latch instead of hold-peek, always-on strip), tests run, linked issue, limitations (no stall detection, pause on provider switch)>; Fixes #1001"
```

- [ ] **Step 7:** Report final state; wait for user confirmation before any merge (conventions: opening a PR never authorizes merging).

---

## Self-review notes (already applied)

- Spec coverage: MCP surface (T1/T5), continuation prompt (T2), durable store + interrupted recovery (T3/T4), state machine incl. cap/error/steering via reducer guards (T4), IPC + modal controls (T6/T7), palette/keybinding/settings (T7), tests incl. system test (T5), issue/PR sync (T8).
- Deliberate spec refinements (record in PR body): loops keyed by sessionId (actuator constraint); latch+strip instead of extending tldr's PreviewKind (different data model); instructions-only domain teaching (no managed product skill — matches the workflows domain pattern).
- Type consistency: `GoalLoopState` fields and `control` action names are identical across T1/T4/T6/T7.
