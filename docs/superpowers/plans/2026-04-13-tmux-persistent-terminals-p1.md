# Tmux-Backed Persistent Terminals (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the direct `node-pty.spawn(shell)` backing for `kind:'terminal'` sessions with a tmux-multiplexed equivalent so terminals survive cc-shell restarts and crashes, while keeping tmux completely invisible to the user.

**Architecture:** A new `TmuxRegistry` service (main-side) detects tmux availability and owns the lifecycle of `ccshell-<uuid>` named tmux sessions (create, list, attach, kill). `TerminalSession` gains a `runtime: 'direct' | 'tmux'` toggle and grows a tmux branch that runs `tmux attach -t <name>` inside its node-pty instead of the user's shell directly. Workspace persistence learns to round-trip the tmux session name. On launch, recovery reconciles `tmux ls` output with persisted state and re-attaches alive sessions instead of respawning.

**Tech Stack:** TypeScript, Electron, node-pty, tmux ≥3.0 (optional system dependency), the existing xterm.js renderer (no changes needed — tmux's output is already an xterm-256color stream).

**Phase scope:** This plan covers **Phase 1 only** — persistent plain shell terminals. Phase 2 (close-with-undo tray), Phase 3 (agent sessions on tmux), and Phase 4 (dispatch / dispatch+mirror commands) each get their own plan written after P1 lands. P1 must produce working software on its own: terminals that survive restart, with graceful fallback to the existing direct-spawn path when tmux isn't installed.

**Out of scope for P1:**
- ClaudeSession / CodexSession remain on direct spawn (P3)
- No undo tray for closed terminals — close still kills the tmux session (P2)
- No dispatch commands (P4)
- No tmux UI in cc-shell (always — explicit non-goal)

---

## File Structure

### Files to create

```
src/main/tmux/TmuxRegistry.ts            — Detect tmux, name+create/list/kill sessions, attach as a child PTY
src/main/tmux/tmuxConfig.ts              — Per-session `tmux set` flags (status off, mouse off, aggressive-resize on)
src/main/tmux/tmuxRecovery.ts            — On-launch reconciliation between persisted state and `tmux ls`
src/main/tmux/verify-tmux.ts             — Standalone `tsx` script that exercises the registry end-to-end against real tmux
docs/superpowers/plans/2026-04-13-tmux-persistent-terminals-p1.md  — this file
```

### Files to modify

```
src/shared/runtime/terminalSession.ts    — Add `runtime: 'direct' | 'tmux'` option; tmux branch spawns `tmux attach`
src/main/sessionManager.ts               — On terminal spawn, ask TmuxRegistry for a session name; on session kill, decide whether to also kill the tmux session (P1: yes, always)
src/main/index.ts                        — Wire TmuxRegistry into app startup; run tmuxRecovery before the renderer is told about persisted sessions
src/preload/index.ts                     — Add `tmuxAvailable(): Promise<boolean>` for renderer-side feature gating (used only to skip persistence advertising, not to expose tmux UI)
src/renderer/src/tiles/workspaceStore.ts — TerminalMeta gains `tmuxName?: string`; persisted-state load path uses it as the recovery key
src/renderer/src/tiles/types.ts          — Add `tmuxName?: string` to SessionMeta
```

### Why this split

`TmuxRegistry` is the single source of truth for tmux-availability and naming. Pulling it out of `TerminalSession` means the same registry can later serve agent sessions (P3) and dispatch commands (P4) without a refactor. `tmuxConfig.ts` is split out because the per-session `tmux set` flags are a stable interface and we'll want to reuse them across runtime classes — keeping them in one file means we can't accidentally drift the UI-suppression flags between code paths. `tmuxRecovery.ts` is split out because the reconciliation logic is the most complex piece and will be exercised standalone by `verify-tmux.ts`.

---

## Pre-flight checks

Before starting Task 1, install tmux locally so the verification scripts have something to talk to:

```bash
brew install tmux
tmux -V    # expect: tmux 3.x or higher
```

If tmux is already installed and you have personal tmux sessions running, **prefix the verification namespace** to `ccshell-test-` (set `TMUX_TEST_PREFIX=ccshell-test-` before running `verify-tmux.ts`) so cleanup never touches your own sessions.

---

## Task 1: TmuxRegistry — detect availability

**Files:**
- Create: `src/main/tmux/TmuxRegistry.ts`
- Create: `src/main/tmux/verify-tmux.ts`

- [ ] **Step 1: Write the verification harness scaffolding**

Create `src/main/tmux/verify-tmux.ts`:

```ts
// Standalone integration check for TmuxRegistry. Run with `tsx`.
// Exits non-zero on any failure. No test framework — this matches
// the verify scripts in the headless packages.

import { TmuxRegistry } from './TmuxRegistry.js'

const PREFIX = process.env.TMUX_TEST_PREFIX ?? 'ccshell-verify-'
let failed = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`✓ ${label}`)
  } else {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

async function main(): Promise<void> {
  const registry = new TmuxRegistry({ namePrefix: PREFIX })

  const available = await registry.detectAvailability()
  check('tmux is available', available, 'install with `brew install tmux`')
  if (!available) process.exit(1)

  // (More checks added in subsequent tasks)

  if (failed > 0) process.exit(1)
}

void main()
```

- [ ] **Step 2: Run the harness — it should fail to compile (TmuxRegistry doesn't exist)**

Run: `npx tsx src/main/tmux/verify-tmux.ts`
Expected: TypeScript error `Cannot find module './TmuxRegistry.js'`

- [ ] **Step 3: Create TmuxRegistry skeleton with detectAvailability**

Create `src/main/tmux/TmuxRegistry.ts`:

```ts
// TmuxRegistry — main-side service that owns every cc-shell-managed
// tmux session.
//
// Why a registry rather than per-session methods:
//   - tmux availability has to be checked once at startup, not per
//     session-spawn. A registry holds that flag.
//   - On launch we have to reconcile persisted state with `tmux ls`
//     output before any session spawns. That reconciliation needs a
//     single object that knows the naming convention.
//   - Future phases (P3 agents, P4 dispatch) will reuse this exact
//     surface. Keeping it in one place means there's no drift.

import { spawn as childSpawn } from 'node:child_process'

export type TmuxRegistryOptions = {
  /** All session names this registry manages will start with this
   *  prefix. Production uses 'ccshell-'; tests use a different
   *  prefix so they never touch the user's real sessions. */
  namePrefix?: string
  /** Override for the tmux binary path. Defaults to 'tmux' on PATH. */
  tmuxBinary?: string
}

export class TmuxRegistry {
  private readonly namePrefix: string
  private readonly tmuxBinary: string
  private availability: boolean | null = null

  constructor(options: TmuxRegistryOptions = {}) {
    this.namePrefix = options.namePrefix ?? 'ccshell-'
    this.tmuxBinary = options.tmuxBinary ?? 'tmux'
  }

  /**
   * Resolve true iff `tmux -V` exits 0. Result is cached for the
   * lifetime of the registry — tmux doesn't get installed mid-session
   * in any realistic scenario, and re-checking on every spawn would
   * add latency to every terminal open.
   */
  async detectAvailability(): Promise<boolean> {
    if (this.availability !== null) return this.availability
    this.availability = await new Promise<boolean>(resolve => {
      const proc = childSpawn(this.tmuxBinary, ['-V'], { stdio: 'ignore' })
      proc.on('error', () => resolve(false))
      proc.on('exit', code => resolve(code === 0))
    })
    return this.availability
  }

  /** Synchronous read of the cached availability flag. Throws if
   *  detectAvailability() hasn't run yet — callers must await
   *  detection during app startup before using the registry. */
  isAvailable(): boolean {
    if (this.availability === null) {
      throw new Error('TmuxRegistry: call detectAvailability() before isAvailable()')
    }
    return this.availability
  }
}
```

- [ ] **Step 4: Run the harness again — should now pass the availability check**

Run: `npx tsx src/main/tmux/verify-tmux.ts`
Expected: `✓ tmux is available` and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/main/tmux/TmuxRegistry.ts src/main/tmux/verify-tmux.ts
git commit -m "feat(tmux): add TmuxRegistry skeleton with availability detection"
```

---

## Task 2: Generate session names + create sessions

**Files:**
- Modify: `src/main/tmux/TmuxRegistry.ts`
- Modify: `src/main/tmux/verify-tmux.ts`
- Create: `src/main/tmux/tmuxConfig.ts`

- [ ] **Step 1: Add tmuxConfig with the per-session UI-suppression flags**

Create `src/main/tmux/tmuxConfig.ts`:

```ts
// Per-session tmux configuration applied via `tmux set -t <name>`
// immediately after `tmux new-session`. These flags are the entire
// reason the user never sees tmux: status bar off, mouse off,
// aggressive-resize on so a smaller secondary attacher (P4 dispatch)
// doesn't shrink the primary view.
//
// Keep this list authoritative — every code path that creates a
// ccshell tmux session must apply these. Drift here would let the
// status bar leak into the renderer's xterm view.

export const TMUX_SESSION_FLAGS: ReadonlyArray<readonly [string, string]> = [
  // Hide the persistent status bar. Without this the renderer would
  // see one row eaten by tmux's bottom chrome.
  ['status', 'off'],
  // Don't intercept mouse events — the renderer wants those.
  ['mouse', 'off'],
  // Per-window: when multiple clients are attached at different sizes,
  // size to each client independently rather than the smallest. This
  // becomes important in P4 (dispatch+mirror) but costs nothing now.
  ['aggressive-resize', 'on'],
]
```

- [ ] **Step 2: Add createSession + sessionExists + killSession to TmuxRegistry**

Add to `src/main/tmux/TmuxRegistry.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { TMUX_SESSION_FLAGS } from './tmuxConfig.js'

// (inside class TmuxRegistry)

/** Generate a fresh, unique session name in this registry's namespace. */
generateName(): string {
  return `${this.namePrefix}${randomUUID()}`
}

/** True iff a tmux session with the given name exists. */
async sessionExists(name: string): Promise<boolean> {
  return new Promise(resolve => {
    const proc = childSpawn(
      this.tmuxBinary,
      ['has-session', '-t', name],
      { stdio: 'ignore' },
    )
    proc.on('error', () => resolve(false))
    proc.on('exit', code => resolve(code === 0))
  })
}

/**
 * Create a detached tmux session running `command`. The session has
 * UI-suppression flags applied before the renderer ever attaches.
 *
 * Detached because the registry's job is to OWN the session — the
 * subsequent attach-as-child-PTY happens in TerminalSession.
 */
async createSession(opts: {
  name: string
  command: string
  args?: string[]
  cwd?: string
}): Promise<void> {
  await this.runTmux([
    'new-session',
    '-d',                  // detached — don't block on a foreground attach
    '-s', opts.name,
    '-c', opts.cwd ?? process.cwd(),
    opts.command,
    ...(opts.args ?? []),
  ])

  // Apply UI-suppression flags. Each `set -t <name>` is a separate
  // call because chaining them is finicky and the cost of N short
  // process spawns at session-create time is irrelevant.
  for (const [key, value] of TMUX_SESSION_FLAGS) {
    await this.runTmux(['set', '-t', opts.name, key, value])
  }
}

/** Kill a session by name. No-op if it doesn't exist. */
async killSession(name: string): Promise<void> {
  if (!(await this.sessionExists(name))) return
  await this.runTmux(['kill-session', '-t', name])
}

/** Run a tmux command, resolving once it exits 0; reject on non-zero. */
private runTmux(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = childSpawn(this.tmuxBinary, args, { stdio: 'ignore' })
    proc.on('error', reject)
    proc.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`tmux ${args.join(' ')} exited ${code}`))
    })
  })
}
```

- [ ] **Step 3: Extend the verification harness with a create→exists→kill round-trip**

Append to the body of `main()` in `src/main/tmux/verify-tmux.ts`:

```ts
const name = registry.generateName()
check('generated name has prefix', name.startsWith(PREFIX))

await registry.createSession({
  name,
  command: process.env.SHELL ?? '/bin/zsh',
  cwd: process.cwd(),
})
check('createSession completes', true)

const existsAfterCreate = await registry.sessionExists(name)
check('sessionExists is true after create', existsAfterCreate)

await registry.killSession(name)
check('killSession completes', true)

const existsAfterKill = await registry.sessionExists(name)
check('sessionExists is false after kill', !existsAfterKill)
```

- [ ] **Step 4: Run the harness — all five checks should pass**

Run: `npx tsx src/main/tmux/verify-tmux.ts`
Expected: 5 lines starting with `✓`, exit code 0.

If `existsAfterCreate` is false, the most likely cause is the shell exiting immediately. Check `tmux ls` manually — if the session is gone, the spawned shell needs `-i` (interactive) or a hold-open command. (zsh and bash launched without an attached terminal usually stay alive in tmux because tmux itself provides the controlling terminal — this should just work.)

- [ ] **Step 5: Commit**

```bash
git add src/main/tmux/TmuxRegistry.ts src/main/tmux/tmuxConfig.ts src/main/tmux/verify-tmux.ts
git commit -m "feat(tmux): create, check existence, and kill named sessions"
```

---

## Task 3: List managed sessions

**Files:**
- Modify: `src/main/tmux/TmuxRegistry.ts`
- Modify: `src/main/tmux/verify-tmux.ts`

- [ ] **Step 1: Add listManagedSessions to TmuxRegistry**

Add to `src/main/tmux/TmuxRegistry.ts`:

```ts
/**
 * Return every tmux session whose name starts with this registry's
 * prefix. Used during launch reconciliation to discover sessions
 * that survived a previous cc-shell run.
 *
 * Returns [] if tmux is unavailable OR if there are no managed
 * sessions — callers shouldn't have to distinguish those cases here
 * (they are different concerns: availability is checked separately
 * at startup, this method just answers "what's alive right now").
 */
async listManagedSessions(): Promise<Array<{ name: string; createdAt: number }>> {
  if (!this.availability) return []

  // -F format string returns one session per line, fields separated
  // by a literal '|' which is illegal in tmux session names so we
  // can safely split on it.
  const out = await this.runTmuxCapture([
    'list-sessions',
    '-F', '#{session_name}|#{session_created}',
  ]).catch(() => '')   // exit-code 1 means "no sessions" — treat as empty

  return out
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [name, createdStr] = line.split('|')
      return { name, createdAt: Number(createdStr) * 1000 }
    })
    .filter(s => s.name.startsWith(this.namePrefix))
}

/** Run a tmux command, resolving with stdout. Reject on non-zero. */
private runTmuxCapture(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = childSpawn(this.tmuxBinary, args)
    let stdout = ''
    proc.stdout.on('data', chunk => { stdout += chunk })
    proc.on('error', reject)
    proc.on('exit', code => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`tmux ${args.join(' ')} exited ${code}`))
    })
  })
}
```

- [ ] **Step 2: Extend the harness — create three sessions, list them, kill them all**

Append to `main()` in `src/main/tmux/verify-tmux.ts`:

```ts
const names = [registry.generateName(), registry.generateName(), registry.generateName()]
for (const n of names) {
  await registry.createSession({
    name: n,
    command: process.env.SHELL ?? '/bin/zsh',
    cwd: process.cwd(),
  })
}
const listed = await registry.listManagedSessions()
const listedNames = new Set(listed.map(s => s.name))
check(
  'listManagedSessions returns all three created sessions',
  names.every(n => listedNames.has(n)),
  `expected ${JSON.stringify(names)}, got ${JSON.stringify([...listedNames])}`,
)
for (const n of names) await registry.killSession(n)
```

- [ ] **Step 3: Run the harness**

Run: `npx tsx src/main/tmux/verify-tmux.ts`
Expected: all checks pass, exit 0. Run `tmux ls` manually after to confirm no leaked `ccshell-verify-*` sessions remain.

- [ ] **Step 4: Commit**

```bash
git add src/main/tmux/TmuxRegistry.ts src/main/tmux/verify-tmux.ts
git commit -m "feat(tmux): list registry-managed sessions"
```

---

## Task 4: TerminalSession learns the tmux runtime

**Files:**
- Modify: `src/shared/runtime/terminalSession.ts`

- [ ] **Step 1: Add the runtime option and tmux-attach branch**

Replace the `TerminalSessionOptions` and constructor body in `src/shared/runtime/terminalSession.ts`:

```ts
export type TerminalSessionOptions = {
  cwd?: string
  cols?: number
  rows?: number
  shell?: string
  env?: Record<string, string | undefined>
  /**
   * Backend used to host the shell.
   *
   *   'direct' — node-pty spawns the shell directly. Original behavior;
   *              terminal dies with cc-shell.
   *
   *   'tmux'   — node-pty spawns `tmux attach -t <tmuxSessionName>`.
   *              The tmux session must already exist (TmuxRegistry
   *              creates it before TerminalSession.start() is called).
   *              Closing this client detaches but does NOT kill the
   *              tmux session — that's the registry's job.
   */
  runtime?: 'direct' | 'tmux'
  /** Required when runtime === 'tmux'. The session name to attach to. */
  tmuxSessionName?: string
  /** Path to tmux binary. Only meaningful when runtime === 'tmux'. */
  tmuxBinary?: string
}
```

Add fields to the class:

```ts
private readonly runtime: 'direct' | 'tmux'
private readonly tmuxSessionName: string | null
private readonly tmuxBinary: string
```

Initialize in the constructor (append after `this.extraEnv = options.env ?? {}`):

```ts
this.runtime = options.runtime ?? 'direct'
this.tmuxSessionName = options.tmuxSessionName ?? null
this.tmuxBinary = options.tmuxBinary ?? 'tmux'
if (this.runtime === 'tmux' && !this.tmuxSessionName) {
  throw new Error('TerminalSession: runtime="tmux" requires tmuxSessionName')
}
```

- [ ] **Step 2: Branch the spawn in start()**

Replace the `this.pty = ptySpawn(this.shell, [], { ... })` block with:

```ts
if (this.runtime === 'tmux' && this.tmuxSessionName) {
  // Attach to a pre-existing tmux session as a child PTY. The
  // registry guarantees the session exists; if it doesn't, tmux
  // will exit immediately and we'll surface that via onExit
  // below — same code path as a shell that crashes on launch.
  this.pty = ptySpawn(
    this.tmuxBinary,
    ['attach', '-t', this.tmuxSessionName],
    {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    },
  )
} else {
  this.pty = ptySpawn(this.shell, [], {
    name: 'xterm-256color',
    cols: this.cols,
    rows: this.rows,
    cwd: this.cwd,
    env,
  })
}
```

- [ ] **Step 3: Update stop() to detach instead of kill when on tmux**

Replace `stop()`:

```ts
async stop(): Promise<void> {
  if (this.runtime === 'tmux' && this.pty) {
    // Detach this client cleanly so the tmux session keeps running
    // for next launch. Sending the tmux detach prefix (^B d) is the
    // most reliable way — killing the PTY would also work but leaves
    // a transient "[detached]" message the next attacher would see.
    try {
      this.pty.write('\x02d')   // ^B then 'd' — tmux's default detach binding
      // Give tmux ~50ms to process the detach before we kill the
      // PTY as a safety net. Without this fall-through, an
      // unresponsive tmux server would leave the PTY orphaned.
      await new Promise(r => setTimeout(r, 50))
    } catch {
      // PTY might already be gone — fall through to kill.
    }
  }
  try {
    this.pty?.kill()
  } catch {
    // already gone
  }
  this.pty = null
}
```

- [ ] **Step 4: Verify direct path still compiles + runs**

Run: `npx tsc --noEmit -p .`
Expected: no type errors.

If you have a way to spawn a direct-mode terminal in cc-shell already, run the dev build (`npm run dev`) and open one — it should behave identically to before.

- [ ] **Step 5: Commit**

```bash
git add src/shared/runtime/terminalSession.ts
git commit -m "feat(tmux): TerminalSession runtime branch — direct vs tmux attach"
```

---

## Task 5: SessionManager wires TmuxRegistry into terminal spawn

**Files:**
- Modify: `src/main/sessionManager.ts`

- [ ] **Step 1: Inject TmuxRegistry into SessionManager**

Find the `SessionManager` class definition. Add a constructor that accepts an optional registry:

```ts
import { TmuxRegistry } from './tmux/TmuxRegistry.js'

// Inside the class:
constructor(private readonly tmuxRegistry: TmuxRegistry | null = null) {
  super()
}
```

If `SessionManager` already has a constructor, fold the parameter in alongside existing arguments — don't duplicate.

- [ ] **Step 2: Branch the terminal spawn path**

Find the terminal-spawn block (search for `kind === 'terminal'` around `sessionManager.ts:200-260`). Replace the `new TerminalSession({ ... })` call with:

```ts
const useTmux = this.tmuxRegistry?.isAvailable() === true
let tmuxSessionName: string | null = null

if (useTmux) {
  tmuxSessionName = this.tmuxRegistry!.generateName()
  // The registry creates the underlying tmux session BEFORE
  // TerminalSession spawns its attach client. Order matters:
  // attaching to a non-existent session fails immediately.
  await this.tmuxRegistry!.createSession({
    name: tmuxSessionName,
    command: options.shell ?? process.env.SHELL ?? '/bin/zsh',
    cwd: options.cwd,
  })
}

const session = new TerminalSession({
  cwd: options.cwd,
  cols: options.cols,
  rows: options.rows,
  shell: options.shell,
  runtime: useTmux ? 'tmux' : 'direct',
  tmuxSessionName: tmuxSessionName ?? undefined,
})
```

Then, after the existing `session.on(...)` wiring, store the tmux name in the registry entry so close() can find it. Add a field to the registry-entry shape:

```ts
| { kind: 'terminal'; session: TerminalSession; tmuxName: string | null }
```

And populate it:

```ts
this.sessions.set(sessionId, { kind: 'terminal', session, tmuxName: tmuxSessionName })
```

- [ ] **Step 3: Kill the tmux session on terminal close (P1 only — P2 introduces the undo tray)**

Find the `kill(sessionId)` method on `SessionManager`. After the `await entry.session.stop()` call (or the equivalent stop path for terminals), add:

```ts
if (entry.kind === 'terminal' && entry.tmuxName && this.tmuxRegistry) {
  await this.tmuxRegistry.killSession(entry.tmuxName)
}
```

- [ ] **Step 4: Compile**

Run: `npx tsc --noEmit -p .`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/sessionManager.ts
git commit -m "feat(tmux): SessionManager spawns terminals via tmux when available"
```

---

## Task 6: App startup wires the registry

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Construct the registry at app startup, await detection, pass to SessionManager**

In `src/main/index.ts`, find where `SessionManager` is instantiated (likely inside `app.whenReady()`). Replace the construction:

```ts
import { TmuxRegistry } from './tmux/TmuxRegistry.js'

// Inside app.whenReady() handler, before SessionManager construction:
const tmuxRegistry = new TmuxRegistry()
const tmuxAvailable = await tmuxRegistry.detectAvailability()
console.log(
  tmuxAvailable
    ? '[tmux] available — terminals will persist across restarts'
    : '[tmux] not installed — terminals will use direct PTY (non-persistent)',
)

const manager = new SessionManager(tmuxAvailable ? tmuxRegistry : null)
```

If SessionManager has other constructor arguments, fold this in alongside them.

- [ ] **Step 2: Run the dev build**

Run: `npm run dev`

In the dev console you should see one of the two `[tmux]` log lines depending on whether tmux is installed.

Open a terminal in cc-shell. It should look identical to before.

- [ ] **Step 3: Verify a tmux session is alive in the background**

In a separate native terminal, run:

```bash
tmux ls
```

You should see one `ccshell-<uuid>` session if you opened a terminal in cc-shell with tmux available. Note its name.

Close cc-shell entirely (cmd+Q). Run `tmux ls` again — the session should still be there.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(tmux): wire registry into app startup, log availability"
```

---

## Task 7: Persist the tmux session name in workspace state

**Files:**
- Modify: `src/renderer/src/tiles/types.ts`
- Modify: `src/renderer/src/tiles/workspaceStore.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/sessionManager.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add tmuxName to SessionMeta**

In `src/renderer/src/tiles/types.ts`, find the `SessionMeta` type (or wherever per-session meta is declared). Add:

```ts
export type SessionMeta = {
  // ... existing fields ...
  /** When this session was spawned via tmux (P1: terminal sessions
   *  only), the registry's session name. Used on launch to recover
   *  by re-attaching instead of respawning. Undefined for direct
   *  PTY sessions. */
  tmuxName?: string
}
```

- [ ] **Step 2: Surface the tmux name from main to renderer at spawn time**

In `src/main/sessionManager.ts`, the `spawn()` method currently returns `Promise<string>` (the sessionId). Either:

(a) Extend the return shape to `{ sessionId: string; tmuxName?: string }`, or
(b) Add an event `tmux-name-assigned` that fires alongside `started`.

Pick (a) — it's the simpler refactor for one new field. Update the return type and the resolver.

In `src/preload/index.ts`, update `spawnSession`'s return type accordingly:

```ts
spawnSession: (options: {
  kind?: SessionKind
  cwd: string
  cols?: number
  rows?: number
  resumeSessionId?: string
}): Promise<{ sessionId: string; tmuxName?: string }> =>
  ipcRenderer.invoke('session:spawn', options),
```

- [ ] **Step 3: Update the renderer to capture and persist tmuxName**

In `src/renderer/src/tiles/workspaceStore.ts`, find every call site of `window.api.spawnSession`. Update them to destructure the new shape and pass `tmuxName` into the SessionMeta record stored in `state.sessions`.

(There may be 2-4 call sites — find them with: `grep -n "spawnSession" src/renderer/src/tiles/workspaceStore.ts`.)

- [ ] **Step 4: Confirm persistence by inspecting workspace.json**

Run: `npm run dev`. Open a terminal. Quit cc-shell.

```bash
cat ~/Library/Application\ Support/cc-shell/workspace.json | python3 -m json.tool | grep -A 3 tmuxName
```

Expected: at least one `"tmuxName": "ccshell-<uuid>"` entry under `sessions`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/tiles/types.ts src/renderer/src/tiles/workspaceStore.ts src/preload/index.ts src/main/sessionManager.ts src/main/index.ts
git commit -m "feat(tmux): persist tmuxName per session"
```

---

## Task 8: Recovery on launch

**Files:**
- Create: `src/main/tmux/tmuxRecovery.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/sessionManager.ts`

- [ ] **Step 1: Write tmuxRecovery**

Create `src/main/tmux/tmuxRecovery.ts`:

```ts
// On-launch reconciliation between persisted workspace state and the
// tmux server's view of the world.
//
// Three buckets:
//   - alive + known   → re-attach (don't respawn)
//   - alive + orphan  → P1: kill (no UI yet to surface them; P2 adds
//                       the undo tray which doubles as recovery surface)
//   - dead  + known   → P1: respawn from scratch (lost state)
//
// We do NOT touch sessions outside our prefix — those belong to the
// user and are none of our business.

import type { TmuxRegistry } from './TmuxRegistry.js'

export type PersistedTerminalRef = {
  sessionId: string
  tmuxName: string
}

export type RecoveryReport = {
  /** tmuxName values that were alive and matched a persisted ref —
   *  caller should re-attach instead of respawning. */
  recoverable: PersistedTerminalRef[]
  /** Persisted sessionIds whose tmuxName was NOT alive — caller
   *  should treat these as fresh spawns. */
  lost: string[]
  /** Alive ccshell-* sessions that were NOT in persisted state.
   *  P1 kills these silently; P2 will route them to the undo tray. */
  orphans: string[]
}

export async function reconcile(
  registry: TmuxRegistry,
  persisted: PersistedTerminalRef[],
): Promise<RecoveryReport> {
  if (!registry.isAvailable()) {
    // No tmux means no recovery is possible — every persisted ref
    // is "lost" by definition (caller will treat as fresh spawn).
    return { recoverable: [], lost: persisted.map(p => p.sessionId), orphans: [] }
  }

  const aliveSessions = await registry.listManagedSessions()
  const aliveNames = new Set(aliveSessions.map(s => s.name))
  const persistedNames = new Set(persisted.map(p => p.tmuxName))

  const recoverable = persisted.filter(p => aliveNames.has(p.tmuxName))
  const lost = persisted
    .filter(p => !aliveNames.has(p.tmuxName))
    .map(p => p.sessionId)
  const orphans = aliveSessions
    .filter(s => !persistedNames.has(s.name))
    .map(s => s.name)

  // P1: silently kill orphans. They're stale ccshell sessions from
  // a previous run that failed to clean up. The registry's prefix
  // guarantees these are ours to kill.
  for (const name of orphans) {
    await registry.killSession(name)
  }

  return { recoverable, lost, orphans }
}
```

- [ ] **Step 2: Add a recovery integration check to verify-tmux.ts**

Append to `main()` in `src/main/tmux/verify-tmux.ts`:

```ts
import { reconcile } from './tmuxRecovery.js'

// Recovery check: create two sessions, simulate one of them being
// "persisted" and the other being an orphan. Reconcile.
const sessionA = registry.generateName()
const sessionB = registry.generateName()
await registry.createSession({ name: sessionA, command: process.env.SHELL ?? '/bin/zsh' })
await registry.createSession({ name: sessionB, command: process.env.SHELL ?? '/bin/zsh' })

const report = await reconcile(registry, [
  { sessionId: 'fake-id-a', tmuxName: sessionA },
  { sessionId: 'fake-id-dead', tmuxName: `${PREFIX}does-not-exist` },
])

check(
  'reconcile recovers the alive+known session',
  report.recoverable.length === 1 && report.recoverable[0].tmuxName === sessionA,
)
check(
  'reconcile flags the dead+known session as lost',
  report.lost.length === 1 && report.lost[0] === 'fake-id-dead',
)
check(
  'reconcile killed the orphan',
  !(await registry.sessionExists(sessionB)),
)

await registry.killSession(sessionA)
```

- [ ] **Step 3: Run the harness**

Run: `npx tsx src/main/tmux/verify-tmux.ts`
Expected: all checks pass, exit 0.

- [ ] **Step 4: Wire reconcile() into app startup, before the renderer loads workspace state**

In `src/main/index.ts`, after constructing `tmuxRegistry` and before `SessionManager`, add a step that reads the persisted workspace, reconciles it, and stashes the result for SessionManager to consume.

The exact wiring depends on how cc-shell's main process loads workspace.json. Find the workspace-load IPC handler (likely a `workspace:load` channel) and ensure recovery happens before any session-spawn happens. A conservative shape:

```ts
import { reconcile, type PersistedTerminalRef } from './tmux/tmuxRecovery.js'
import { readFile } from 'node:fs/promises'
import { workspaceJsonPath } from './workspaceFiles.js'   // wherever that lives

let recoveryReport = { recoverable: [] as PersistedTerminalRef[], lost: [] as string[], orphans: [] as string[] }

if (tmuxAvailable) {
  try {
    const raw = await readFile(workspaceJsonPath(), 'utf8')
    const parsed = JSON.parse(raw)
    const persisted: PersistedTerminalRef[] = Object.entries(parsed.sessions ?? {})
      .filter(([, meta]: [string, any]) => meta.kind === 'terminal' && typeof meta.tmuxName === 'string')
      .map(([sessionId, meta]: [string, any]) => ({ sessionId, tmuxName: meta.tmuxName }))
    recoveryReport = await reconcile(tmuxRegistry, persisted)
    console.log(`[tmux] recovery: ${recoveryReport.recoverable.length} recoverable, ${recoveryReport.lost.length} lost, ${recoveryReport.orphans.length} orphans cleaned`)
  } catch (err) {
    console.warn('[tmux] recovery failed (treating all sessions as fresh):', err)
  }
}

const manager = new SessionManager(tmuxAvailable ? tmuxRegistry : null, recoveryReport.recoverable)
```

Update `SessionManager`'s constructor signature to accept the second arg and store it:

```ts
constructor(
  private readonly tmuxRegistry: TmuxRegistry | null = null,
  private readonly recoverableTerminals: ReadonlyArray<{ sessionId: string; tmuxName: string }> = [],
) {
  super()
}

private isRecoverable(sessionId: string): string | null {
  return this.recoverableTerminals.find(r => r.sessionId === sessionId)?.tmuxName ?? null
}
```

- [ ] **Step 5: Branch the spawn path on recovery**

Back in `SessionManager.spawn()` for `kind === 'terminal'`, before generating a fresh tmux name, check whether this sessionId was recoverable:

```ts
const recoverableName = this.isRecoverable(sessionId)
const useTmux = this.tmuxRegistry?.isAvailable() === true

let tmuxSessionName: string | null = null

if (useTmux && recoverableName) {
  // Reattach path — tmux session already exists from a previous
  // launch. We just need to point a fresh TerminalSession at it.
  tmuxSessionName = recoverableName
} else if (useTmux) {
  tmuxSessionName = this.tmuxRegistry!.generateName()
  await this.tmuxRegistry!.createSession({
    name: tmuxSessionName,
    command: options.shell ?? process.env.SHELL ?? '/bin/zsh',
    cwd: options.cwd,
  })
}
```

But the renderer uses fresh `sessionId`s on every launch (the workspace store re-spawns and remaps ids). So `isRecoverable(newSessionId)` would always return null. We need to match by **persisted sessionId** before remapping happens.

Read `src/renderer/src/tiles/workspaceStore.ts` near the persisted-state load (search for `loadWorkspace` and the surrounding remap logic) to confirm whether persisted sessionIds are passed through to spawn or replaced. If they're replaced, the recovery match must happen at a different layer — the renderer needs to pass the persisted `tmuxName` (not the persisted sessionId) into the `spawnSession` IPC call so main can use it directly.

Add an optional input field to spawn:

```ts
// In preload/index.ts SpawnSession signature:
spawnSession: (options: {
  kind?: SessionKind
  cwd: string
  cols?: number
  rows?: number
  resumeSessionId?: string
  /** When set AND tmux is available, attach to this existing tmux
   *  session instead of creating a new one. Used by the workspace
   *  reload path to recover persistent terminals. */
  recoverTmuxName?: string
}): Promise<{ sessionId: string; tmuxName?: string }> =>
  ipcRenderer.invoke('session:spawn', options),
```

In `SessionManager.spawn`:

```ts
let tmuxSessionName: string | null = null

if (useTmux && options.recoverTmuxName && (await this.tmuxRegistry!.sessionExists(options.recoverTmuxName))) {
  // Renderer asked to recover a specific session and it's still alive.
  tmuxSessionName = options.recoverTmuxName
} else if (useTmux) {
  tmuxSessionName = this.tmuxRegistry!.generateName()
  await this.tmuxRegistry!.createSession({
    name: tmuxSessionName,
    command: options.shell ?? process.env.SHELL ?? '/bin/zsh',
    cwd: options.cwd,
  })
}
```

In `workspaceStore.ts`, the load path that respawns sessions reads each persisted SessionMeta and calls `spawnSession`. Add the `recoverTmuxName` field there:

```ts
// (inside the persisted-session respawn loop)
const result = await window.api.spawnSession({
  kind: persistedMeta.kind,
  cwd: persistedMeta.cwd,
  cols, rows,
  recoverTmuxName: persistedMeta.tmuxName,
})
```

- [ ] **Step 6: End-to-end manual test**

1. `npm run dev`
2. Open a terminal pane, `cd ~/Desktop`, `echo "marker $(date)"`. Note the marker line.
3. cmd+Q to quit cc-shell.
4. `tmux ls` — confirm the `ccshell-<uuid>` session is still alive.
5. `npm run dev` again.
6. The terminal pane should reappear with the same scrollback including your marker line.

If the pane respawns blank, check `tmux capture-pane -t <name> -p` to confirm the tmux session has the content — the bug is then in the renderer recovery path (likely a missed `recoverTmuxName` passthrough).

- [ ] **Step 7: Commit**

```bash
git add src/main/tmux/tmuxRecovery.ts src/main/index.ts src/main/sessionManager.ts src/main/tmux/verify-tmux.ts src/preload/index.ts src/renderer/src/tiles/workspaceStore.ts
git commit -m "feat(tmux): launch-time recovery — re-attach alive sessions, GC orphans"
```

---

## Task 9: End-to-end verification

**Files:** none — manual + automated checks only.

- [ ] **Step 1: Run the verify-tmux harness one more time and confirm zero leftover sessions**

```bash
npx tsx src/main/tmux/verify-tmux.ts
tmux ls 2>/dev/null | grep ccshell-verify- && echo "LEAK" || echo "clean"
```

Expected: `clean`. If `LEAK`, the harness has a missing teardown — fix before declaring P1 done.

- [ ] **Step 2: Confirm the no-tmux fallback path**

Temporarily move the tmux binary aside (or set `TmuxRegistry`'s binary path to `/nonexistent`) and run `npm run dev`. Confirm:

- The startup log says `[tmux] not installed`.
- A terminal opens normally and works.
- Quitting and restarting respawns the terminal blank — no recovery, but also no crash.

Restore the tmux binary.

- [ ] **Step 3: Confirm restart recovery for two terminals**

1. `npm run dev`. Open two terminal panes in two different cwds with distinct marker output in each.
2. cmd+Q.
3. `npm run dev`. Both should restore with their scrollback intact and live (try typing — input should reach the recovered shell).

- [ ] **Step 4: Confirm orphan cleanup**

1. `tmux new-session -d -s ccshell-orphan-test 'sleep 9999'`
2. `npm run dev`.
3. Check the startup log — should report 1 orphan cleaned.
4. `tmux ls | grep ccshell-orphan-test` — should be empty.

- [ ] **Step 5: Commit nothing — just record the result in the PR description.**

---

## Self-Review

**Spec coverage**

| Spec point | Task |
| --- | --- |
| Optional tmux dependency | Tasks 1, 6 (detect + log + fallback) |
| Persistent terminals across restart | Tasks 4, 7, 8 |
| Identification of dead/stale sessions | Task 8 (orphan cleanup) |
| No tmux UI in cc-shell | Task 2 (`tmuxConfig` flags), Task 4 (detach via `^B d` not visible to user) |
| Phase 1 only (no undo, no agents, no dispatch) | Stated in header + out-of-scope list |

**Type consistency**

- `tmuxName` (SessionMeta field), `tmuxSessionName` (TerminalSession option), `recoverTmuxName` (spawn IPC option) — three names for "the tmux session string". Renamed for cross-layer clarity (meta is what's persisted, option is the constructor arg name, recover is the spawn-time hint), but they all hold the same value. Documented in their respective field doc comments.
- `RecoveryReport` shape used by Task 8 wiring matches the `reconcile()` return — checked.
- `TmuxRegistry`'s `isAvailable()` throws if `detectAvailability()` hasn't run; Task 6 awaits detect before any other call. ✓

**Placeholder scan**

- No "TBD" / "implement later" instances.
- Task 5 Step 2 says "fold the parameter in alongside existing arguments" — that's a real instruction (the constructor may or may not exist), not a placeholder.
- Task 8 Step 4 says "the exact wiring depends on how cc-shell's main process loads workspace.json" — this is a real "go look at the code first" instruction, not a placeholder. Engineer should grep for `workspace:load` and confirm before pasting.

**Risks**

1. **node-pty + tmux on macOS**: tmux's signal handling under a node-pty parent isn't routinely tested. If detach via `^B d` proves unreliable, fall back to plain `pty.kill()` — tmux survives client kill cleanly.
2. **Multi-cwd recovery**: the same tmux session can't change its starting cwd post-creation. Recovery just re-attaches; if the user `cd`'d somewhere during the previous session, they'll resume there. This is the desired behavior, but worth noting.
3. **Long-running orphans**: P1 silently kills orphans. If a user has a long-running script in a ccshell session and cc-shell crashed without persisting it, that script gets killed on next launch. P2's undo tray + recovery prompt fixes this; for P1 we accept the loss.

---

## Phase Roadmap (informational)

P1 (this plan) — persistent plain terminals.
P2 — close-with-undo tray, surfaces orphans as restorable instead of killing them.
P3 — agent (Claude/Codex) sessions on tmux backend.
P4 — dispatch and dispatch+mirror commands.

Each gets its own plan when P1 lands.
