# Agent Terminal Follow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jump to Latest and auto-follow (Tail / Tail All) work for agent sessions showing their raw terminal surface (`AgentTerminalLeaf` — OpenCode Terminal, hybrid fallback, Claude/Codex toggled to terminal view), with renderer integration tests.

**Architecture:** The workspace already broadcasts follow intent through per-session runtime state (`runtime.scrollToLatestRequest`, `runtime.tailMode`) and app state (`tailAllMode`). Only the rendered `Feed` consumes it today. We add a co-located hook (`useAgentTerminalFollow`) that `AgentTerminalLeaf` uses to drive the xterm viewport, remove the `renderedViewPolicy` gate that hides the two commands on terminal surfaces, and prove behavior with renderer integration tests that drive PTY data through the real `sessionDataDispatcher`.

**Tech Stack:** React 18 hooks, xterm.js (`@xterm/xterm`), Zustand app store, Vitest renderer project (`happy-dom` + `@testing-library/react`).

**Worktree:** `.worktrees/agent-terminal-follow`, branch `feat/agent-terminal-follow` (this plan is the first commit on the branch).

---

## Background an implementer needs

- `AgentTerminalLeaf` (`src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx`) is the full-pane raw PTY view for agent sessions. Its xterm mount effect is **keyed on `[sessionId]` alone** and reads changing runtime state through `runtimeRef` — remounting xterm on every runtime change would lose scrollback and re-attach the PTY. New runtime-driven behavior must live in **separate effects** outside the mount effect and reach the terminal through `termRef` / refs.
- `TileLeaf`'s effective-tail mask (src/renderer/src/workspace/tile-tree/TileLeaf.tsx:206): `(runtime.tailMode || tailAllMode) && !workspaceHidden`. The terminal-surface analog of `!workspaceHidden` is `useAgentTerminalOwnerVisible()` (`src/renderer/src/workspace/terminal/AgentTerminalOwnership.tsx`) — it composes the Global-Editor-fullscreen and Reader/Spotlight/Settings retention shells. Folding visibility into the mask matters for the same reason it does in TileLeaf: a re-reveal must be a genuine false→true transition so follow re-engages.
- `Feed` semantics we are mirroring (src/renderer/src/features/feed/ui/Feed.tsx):
  - Tail re-pins on any scroll while active and auto-scrolls on new entries.
  - Tail is **non-destructive**: the pre-tail reading position survives and is restored on disengage (see the "WHY tailing deliberately does NOT persist" comment).
- PTY bytes reach the leaf through `subscribeToAgentPtyData` (src/renderer/src/workspace/terminal/sessionDataDispatcher.ts), which subscribes once to `window.api.onSessionAgentPtyData` and fans out by session id. Tests drive this channel by capturing the listener passed to a mocked `window.api.onSessionAgentPtyData` — that exercises the real dispatcher, real subscription, and real leaf write path.
- Both follow commands are currently **unreachable** on terminal surfaces, independently of the leaf gap: `toggle-tail` and `jump-latest-message` carry `renderedViewPolicy: { kind: 'requires-rendered-feed' }`, and `commandAllowedByRenderedViewPolicy` (src/renderer/src/workspace/agentDisplayMode.ts:150) returns false for any policy when `providerRuntime === 'terminal'` (OpenCode Terminal) and false for `requires-rendered-feed` whenever the effective surface is terminal. The `when` guard (`kind !== 'terminal'`) already excludes plain shell panes and stays.
- xterm APIs used (all real): `term.scrollToBottom()`, `term.onScroll(cb) → IDisposable`, `term.buffer.active.viewportY` (get/set), `term.buffer.active.length`, `term.rows`, `term.write(data, callback)` where `callback` fires after xterm has parsed the chunk. On alternate-screen TUIs there is no scrollback and all of this is a harmless no-op; it matters for normal-buffer output streams.
- Test harness pattern to copy: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.submit.renderer.test.tsx` (mocked `@xterm/xterm` class, `window.api` on `window`, `AgentTerminalOwnershipProvider` + `MountedAgentTerminalOwner`, deferred `attachAgentPty`, stubbed `requestAnimationFrame`/`ResizeObserver`).

## File structure

- Create: `src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts` — the follow hook (jump, tail engage/disengage/restore) + `isXtermViewportAtBottom` helper. One responsibility: translating follow intent into xterm viewport calls.
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx` — compute `tailActive`, call the hook, wire `follow.attach` + write-callback scrolling into the existing mount effect, TAIL pill in the header.
- Create: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx` — integration tests (harness + one file, tests appended per task).
- Modify: `src/renderer/src/features/workspace/commands/paneCommands.ts` — drop `renderedViewPolicy` from the two commands, update copy and comments.
- Create: `src/renderer/src/features/workspace/commands/paneCommands.follow.renderer.test.ts` — regression test that the two commands stay surface-agnostic and shell-excluded.

---

### Task 1: Set up the worktree and verify a clean baseline

**Files:** none (verification only)

- [ ] **Step 1: Install dependencies (includes submodules for aliases + electron-rebuild for node-pty)**

Run in `.worktrees/agent-terminal-follow`:
```bash
git submodule update --init --recursive && npm install
```
Expected: exit 0. (`npm install` runs `electron-rebuild -f -w node-pty`; renderer tests do not load node-pty, so a rebuild warning is tolerable, a hard failure is not.)

- [ ] **Step 2: Run the existing AgentTerminalLeaf renderer tests**

```bash
npm run test:renderer -- AgentTerminalLeaf.submit
```
Expected: PASS (3 tests). If this fails, stop and report — the plan's harness is modeled on this file.

- [ ] **Step 3: Typecheck baseline**

```bash
npm run typecheck
```
Expected: exit 0.

---

### Task 2: Follow hook — Jump to Latest

**Files:**
- Create: `src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts`
- Create: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx`
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx`

- [ ] **Step 1: Write the failing tests (full harness + jump tests)**

Create `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx`:

```tsx
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import {
  AgentTerminalOwnershipProvider,
  AgentTerminalOwnerVisibilityProvider,
  MountedAgentTerminalOwner,
} from '@renderer/workspace/terminal/AgentTerminalOwnership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { AgentTerminalLeaf } from './AgentTerminalLeaf'

// Integration harness for follow behavior (jump-to-latest + tail) on the raw
// agent terminal surface. Modeled on AgentTerminalLeaf.submit.renderer.test.tsx
// with three deltas: the mocked Terminal grows scroll surface area
// (scrollToBottom / onScroll / buffer viewport), the app-store mock is MUTABLE
// so tests can flip tailAllMode like the real store would, and the agent PTY
// channel listener is captured so tests push bytes through the REAL
// sessionDataDispatcher fanout instead of calling leaf internals.
type MockTerminal = {
  rows: number
  buffer: { active: { viewportY: number; length: number } }
  scrollToBottom: ReturnType<typeof vi.fn>
  onScrollListener: ((line: number) => void) | null
}

const xtermHarness = vi.hoisted(() => ({
  cols: 120,
  rows: 40,
  instances: [] as MockTerminal[],
  attachWebgl: vi.fn(),
  fit: vi.fn(),
}))

const appStore = vi.hoisted(() => ({
  settings: {
    dictationEnabled: false,
    dictationProvider: 'local',
    dictationShortcut: 'off',
    mouseModeEnabled: false,
  },
  tailAllMode: false,
}))

vi.mock('@renderer/workspace/terminal/xtermWebglRenderer', () => ({
  attachXtermWebglRenderer: xtermHarness.attachWebgl,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = xtermHarness.cols
    rows = xtermHarness.rows
    options: Record<string, unknown> = {}
    container: HTMLElement | null = null
    onDataListener: ((data: string) => void) | null = null
    onScrollListener: ((line: number) => void) | null = null
    buffer = { active: { viewportY: 0, length: 1 } }
    // scrollToBottom intentionally does NOT emit onScroll: real xterm does,
    // but our handler then sees an at-bottom viewport and no-ops, so the mock
    // keeps call counts deterministic. Re-pin behavior is tested by invoking
    // the registered onScroll listener directly.
    scrollToBottom = vi.fn(() => {
      this.buffer.active.viewportY = Math.max(0, this.buffer.active.length - this.rows)
    })
    dispose = vi.fn()
    inputDispose = vi.fn(() => { this.onDataListener = null })
    scrollDispose = vi.fn(() => { this.onScrollListener = null })
    constructor() { xtermHarness.instances.push(this as unknown as MockTerminal) }
    loadAddon() {}
    open(container: HTMLElement) { this.container = container }
    onData(listener: (data: string) => void) {
      this.onDataListener = listener
      return { dispose: this.inputDispose }
    }
    onScroll(listener: (line: number) => void) {
      this.onScrollListener = listener
      return { dispose: this.scrollDispose }
    }
    write(_data: string, callback?: () => void) { callback?.() }
    focus() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() { xtermHarness.fit() } },
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: typeof appStore) => unknown) => selector(appStore),
}))

vi.mock('@renderer/app-state/settings/theme', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  THEME_CHANGED_EVENT: 'agent-code:test-theme-change',
  getActiveAppFontFamily: () => 'monospace',
}))

vi.mock('@renderer/workspace/tile-tree/xtermTheme', () => ({
  readXtermTheme: () => ({}),
  syncXtermTheme: () => {},
}))

vi.mock('@renderer/workspace/tile-tree/TileLeaf/useComposerDictation', () => ({
  useComposerDictation: () => {},
}))

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

type PtyEvent = { sessionId: string; data: string }

describe('AgentTerminalLeaf follow (jump-to-latest + tail)', () => {
  let attach: Deferred<string | null>
  let nextFrameId: number
  let frames: Map<number, FrameRequestCallback>
  let ptyListener: ((event: PtyEvent) => void) | null = null
  const api = {
    attachAgentPty: vi.fn((_id: string) => attach.promise),
    detachAgentPty: vi.fn().mockResolvedValue(undefined),
    onSessionAgentPtyData: vi.fn((listener: (event: PtyEvent) => void) => {
      ptyListener = listener
      return () => { ptyListener = null }
    }),
    onSessionTerminalData: vi.fn(() => () => {}),
    resize: vi.fn().mockResolvedValue(undefined),
    sendInput: vi.fn().mockResolvedValue(undefined),
  }
  const workspace = {
    acknowledgeSession: vi.fn(),
    ensureSessionLive: vi.fn().mockResolvedValue(undefined),
    showPaneToast: vi.fn(),
  } as unknown as Workspace

  const runtimeWith = (patch: Partial<SessionRuntime>): SessionRuntime => ({
    ...emptyRuntime(),
    processStatus: 'started',
    ...patch,
  })

  function leaf(runtime: SessionRuntime = runtimeWith({})) {
    return (
      <AgentTerminalOwnershipProvider>
        <MountedAgentTerminalOwner sessionId="session-1">
          <AgentTerminalLeaf
            sessionId="session-1"
            focused
            onFocusRequest={() => {}}
            workspace={workspace}
            runtime={runtime}
            projectDir="/tmp/project"
            provider="codex"
          />
        </MountedAgentTerminalOwner>
      </AgentTerminalOwnershipProvider>
    )
  }

  function flushAnimationFrames() {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(performance.now())
  }

  async function attachResolved(buffer = '') {
    act(() => flushAnimationFrames())
    await act(async () => {
      attach.resolve(buffer)
      await attach.promise
    })
  }

  function term(): MockTerminal {
    return xtermHarness.instances[0]
  }

  beforeEach(() => {
    appStore.tailAllMode = false
    attach = deferred<string | null>()
    nextFrameId = 0
    frames = new Map()
    ptyListener = null
    xtermHarness.fit.mockClear()
    xtermHarness.instances.length = 0
    xtermHarness.attachWebgl.mockReset()
    xtermHarness.attachWebgl.mockImplementation(() => ({
      ready: Promise.resolve(true),
      dispose: vi.fn(),
    }))
    api.attachAgentPty.mockReset().mockImplementation(() => attach.promise)
    api.detachAgentPty.mockClear()

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
    vi.stubGlobal('ResizeObserver', class {
      disconnect = vi.fn()
      observe() {}
      unobserve() {}
    })
    Object.defineProperty(window, 'api', { configurable: true, value: api })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
    vi.unstubAllGlobals()
  })

  it('ignores the pre-existing jump request baseline on mount', async () => {
    render(leaf(runtimeWith({ scrollToLatestRequest: 3 })))
    await attachResolved()
    expect(term().scrollToBottom).not.toHaveBeenCalled()
  })

  it('scrolls the xterm viewport once when a new jump-to-latest request arrives', async () => {
    const view = render(leaf(runtimeWith({ scrollToLatestRequest: 3 })))
    await attachResolved()
    act(() => { view.rerender(leaf(runtimeWith({ scrollToLatestRequest: 4 }))) })
    expect(term().scrollToBottom).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:renderer -- AgentTerminalLeaf.follow
```
Expected: FAIL — the rerendered request does nothing; first test may pass vacuously (it is the guard against over-triggering, the second is the red one).

- [ ] **Step 3: Implement the hook (jump path only)**

Create `src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts`:

```ts
import { useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'

// Follow behavior for raw agent terminal surfaces (AgentTerminalLeaf) — the
// xterm counterpart of what Feed does for the rendered surface:
//   - Jump to Latest: the workspace bumps `runtime.scrollToLatestRequest`
//     whenever the user asks to return to the bottom (palette command, prompt
//     send). Feed scrolls its DOM scroller; a raw pane scrolls the xterm
//     viewport instead. Nothing consumed this counter on the terminal surface
//     before, so the command silently did nothing there.
//   - Tail (auto-follow): mirrors Feed's semantics — pin to bottom while
//     active, re-pin if the user scrolls away, and restore the pre-tail
//     viewport line on disengage so following is non-destructive. Feed
//     protects the saved position for the same reason (see Feed.tsx "WHY
//     tailing deliberately does NOT persist").
//
// WHY a hook instead of inline effects in AgentTerminalLeaf: the leaf's xterm
// mount effect is deliberately keyed on [sessionId] alone (remounting xterm on
// every runtime change would lose scrollback and re-attach the PTY), so
// runtime-driven behavior must live outside that effect and reach the terminal
// through refs. Collecting it here also gives the renderer tests one unit to
// target. The hook MUST be called before the leaf's mount effect — see the
// wiring comment in AgentTerminalLeaf.

/** Viewport is at bottom when its top line plus rows covers the buffer. */
export function isXtermViewportAtBottom(term: Terminal): boolean {
  const buffer = term.buffer.active
  return buffer.viewportY >= buffer.length - term.rows
}

type FollowArgs = {
  /** Live runtime counter; every increment is one jump-to-latest request. */
  scrollToLatestRequest: number
  /** Computed tail verdict (per-session Tail OR Tail All, masked by visibility). */
  tailActive: boolean
  /** The leaf's terminal ref; null until the mount effect creates xterm. */
  termRef: RefObject<Terminal | null>
}

export type AgentTerminalFollowHandle = {
  /** Tail verdict for the PTY write path inside the leaf's mount effect. */
  readonly tailActiveRef: Readonly<{ current: boolean }>
  /** Wire re-pin-on-user-scroll to a freshly created Terminal instance. */
  attach: (term: Terminal) => () => void
}

export function useAgentTerminalFollow({
  scrollToLatestRequest,
  tailActive,
  termRef,
}: FollowArgs): AgentTerminalFollowHandle {
  // WHY render-time assignment (mirroring runtimeRef in AgentTerminalLeaf):
  // the PTY subscriber in the mount effect reads this ref at IPC-event time,
  // long after any effect ordering, and the mount effect itself must never
  // re-run for follow-state changes.
  const tailActiveRef = useRef(tailActive)
  tailActiveRef.current = tailActive

  // Jump to Latest. WHY a baseline ref: the counter can already be non-zero
  // from the session's rendered-surface life, and remounting the pane must
  // not replay an old request against a fresh xterm — the attach replay
  // already leaves a fresh terminal at the bottom.
  const jumpBaselineRef = useRef<number | null>(null)
  useEffect(() => {
    if (jumpBaselineRef.current === null) {
      jumpBaselineRef.current = scrollToLatestRequest
      return
    }
    if (scrollToLatestRequest === jumpBaselineRef.current) return
    jumpBaselineRef.current = scrollToLatestRequest
    termRef.current?.scrollToBottom()
  }, [scrollToLatestRequest, termRef])

  // Stable handle: the leaf's mount effect is keyed on [sessionId] and must
  // not be invalidated by follow-state churn.
  return useMemo<AgentTerminalFollowHandle>(() => ({
    tailActiveRef,
    attach: _term => () => {},
  }), [])
}
```

(`attach` is a placeholder returning a no-op disposer until Task 5 wires `onScroll`; the signature is final.)

- [ ] **Step 4: Wire the hook into AgentTerminalLeaf**

In `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx`:

Add the import with the other tile-tree imports:

```ts
import { useAgentTerminalFollow } from '@renderer/workspace/tile-tree/agentTerminalFollow'
```

After `const ownerVisible = useAgentTerminalOwnerVisible()` (currently line ~86) add:

```tsx
const tailAllMode = useAppStore(state => state.tailAllMode)
// Feed-parity tail mask (TileLeaf's effectiveTailMode): per-session Tail OR
// Tail All, suppressed while this subtree is hidden (editor fullscreen /
// Reader/Spotlight/Settings takeover) — a display:none pane cannot scroll,
// and folding visibility into the mask makes re-reveal a genuine transition
// that re-engages follow.
const tailActive = (runtime.tailMode || tailAllMode) && ownerVisible
// WHY this hook must be called BEFORE the xterm mount effect below: its
// effects read termRef.current at effect time and React runs passive effects
// in declaration order — when tail is already on at mount, the terminal does
// not exist yet, which is exactly the "nothing to restore" case.
const follow = useAgentTerminalFollow({
  scrollToLatestRequest: runtime.scrollToLatestRequest,
  tailActive,
  termRef,
})
```

In the mount effect, after `termRef.current = term` (currently line ~242) add:

```ts
const offFollowAttach = follow.attach(term)
```

In the mount-effect cleanup, next to `onDataDisposable?.dispose()` add:

```ts
offFollowAttach()
```

(The mount effect's dep array stays `[sessionId]` — `follow` is a stable `useMemo` handle, so closing over it does not invalidate the keying; this mirrors the existing refs-not-deps rationale in the "WHY this goes through refs" comment.)

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run test:renderer -- AgentTerminalLeaf.follow
```
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx
git commit -m "feat(workspace): honor jump-to-latest on agent terminal surfaces"
```

---

### Task 3: Tail engage, disengage, and non-destructive restore

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts`
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx`

- [ ] **Step 1: Write the failing tests** — append inside the `describe` block:

```tsx
describe('tail engage/disengage', () => {
  it('pins to bottom on engage and restores the pre-tail viewport line on disengage', async () => {
    const view = render(leaf())
    await attachResolved()
    term().buffer.active.length = 500
    term().buffer.active.viewportY = 100 // user scrolled up
    act(() => { view.rerender(leaf(runtimeWith({ tailMode: true }))) })
    expect(term().scrollToBottom).toHaveBeenCalled()
    expect(term().buffer.active.viewportY).toBe(460) // 500 - rows(40)
    act(() => { view.rerender(leaf(runtimeWith({ tailMode: false }))) })
    expect(term().buffer.active.viewportY).toBe(100)
  })

  it('keeps the bottom on disengage when tail engaged at the bottom', async () => {
    const view = render(leaf())
    await attachResolved()
    term().buffer.active.length = 500
    term().buffer.active.viewportY = 460 // at bottom
    act(() => { view.rerender(leaf(runtimeWith({ tailMode: true }))) })
    act(() => { view.rerender(leaf(runtimeWith({ tailMode: false }))) })
    expect(term().buffer.active.viewportY).toBe(460)
  })

  it('does not restore when tail was already on at mount (fresh terminal)', async () => {
    const view = render(leaf(runtimeWith({ tailMode: true })))
    await attachResolved()
    term().buffer.active.length = 500
    term().buffer.active.viewportY = 460 // user sat at the bottom
    act(() => { view.rerender(leaf(runtimeWith({ tailMode: false }))) })
    // Engage happened before xterm existed — nothing was saved, disengage
    // must not invent a position and yank the user to the top.
    expect(term().buffer.active.viewportY).toBe(460)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:renderer -- AgentTerminalLeaf.follow
```
Expected: FAIL — engage does nothing yet (all three: no pin, no restore).

- [ ] **Step 3: Implement engage/disengage in the hook**

Add after the jump effect in `agentTerminalFollow.ts`:

```ts
// Tail engage/disengage. Non-destructive like Feed: only a viewport that was
// genuinely scrolled up has a position worth restoring; engaging while at
// bottom saves nothing and disengage leaves the bottom. On mount with tail
// already on, this effect runs before xterm exists (declaration order — see
// the leaf wiring), so nothing is saved and disengage keeps the bottom the
// attach replay left us at.
const tailEngagedRef = useRef(false)
const savedViewportYRef = useRef<number | null>(null)
useEffect(() => {
  const activeTerm = termRef.current
  if (tailActive && !tailEngagedRef.current) {
    tailEngagedRef.current = true
    if (activeTerm) {
      savedViewportYRef.current = isXtermViewportAtBottom(activeTerm)
        ? null
        : activeTerm.buffer.active.viewportY
      activeTerm.scrollToBottom()
    }
    return
  }
  if (!tailActive && tailEngagedRef.current) {
    tailEngagedRef.current = false
    const saved = savedViewportYRef.current
    savedViewportYRef.current = null
    if (activeTerm && saved !== null) {
      const buffer = activeTerm.buffer.active
      buffer.viewportY = Math.min(saved, Math.max(0, buffer.length - activeTerm.rows))
    }
  }
}, [tailActive, termRef])
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test:renderer -- AgentTerminalLeaf.follow
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx
git commit -m "feat(workspace): engage and restore tail follow on agent terminal surfaces"
```

---

### Task 4: Follow PTY output (write path) and pin after attach replay

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx`
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx`

- [ ] **Step 1: Write the failing tests** — append inside the top-level `describe` (after the jump tests):

```tsx
it('follows PTY output through the dispatcher while per-session tail is on', async () => {
  render(leaf(runtimeWith({ tailMode: true })))
  await attachResolved()
  term().buffer.active.length = 500
  act(() => { ptyListener?.({ sessionId: 'session-1', data: 'stream' }) })
  expect(term().scrollToBottom).toHaveBeenCalled()
  expect(term().buffer.active.viewportY).toBe(460)
})

it('pins after the attach replay when tail is on', async () => {
  render(leaf(runtimeWith({ tailMode: true })))
  await attachResolved('backfill')
  // Tail engaged before xterm existed, so the pin has to come from the
  // post-replay moment in tryAttach — proving that branch ran.
  expect(term().scrollToBottom).toHaveBeenCalled()
})

it('leaves the viewport alone on PTY output while tail is off', async () => {
  render(leaf())
  await attachResolved()
  term().buffer.active.viewportY = 10
  term().buffer.active.length = 500
  act(() => { ptyListener?.({ sessionId: 'session-1', data: 'stream' }) })
  expect(term().scrollToBottom).not.toHaveBeenCalled()
  expect(term().buffer.active.viewportY).toBe(10)
})
```

Note: `ptyListener` is captured in `beforeEach` via the `onSessionAgentPtyData` mock — these tests push bytes through the real `sessionDataDispatcher`, not a leaf callback.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:renderer -- AgentTerminalLeaf.follow
```
Expected: FAIL — first two (no follow, no post-replay pin); third passes vacuously.

- [ ] **Step 3: Implement the write path in the leaf's mount effect**

In `AgentTerminalLeaf.tsx`, replace the live-write branch of the PTY subscriber (currently `term?.write(data)`):

```ts
offPtyData = subscribeToAgentPtyData(sessionId, data => {
  if (!attachedBackfillDone) {
    backlogQueue.push(data)
    if (backlogQueue.length > 256) backlogQueue.splice(0, backlogQueue.length - 256)
    return
  }
  // Tail scrolls in the write completion callback: xterm parses chunks
  // asynchronously, so scrolling synchronously would target the pre-parse
  // bottom and land one chunk early.
  const liveTerm = term
  if (follow.tailActiveRef.current) {
    liveTerm?.write(data, () => liveTerm.scrollToBottom())
  } else {
    liveTerm?.write(data)
  }
})
```

And inside `tryAttach`, immediately after `attachedBackfillDone = true`:

```ts
// A fresh terminal follows its replay by default, but engage-while-mounted
// (or Tail All flipping during a remount) wants the pin explicit once the
// backfill exists — the replay itself does not go through the write path.
if (follow.tailActiveRef.current) liveTerm.scrollToBottom()
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test:renderer -- AgentTerminalLeaf.follow
```
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx
git commit -m "feat(workspace): tail agent terminal output during PTY writes"
```

---

### Task 5: Re-pin on user scroll + TAIL pill

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts`
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx`
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx`

- [ ] **Step 1: Write the failing tests** — append inside the top-level `describe`:

```tsx
it('re-pins when the user scrolls away while tailing', async () => {
  render(leaf(runtimeWith({ tailMode: true })))
  await attachResolved()
  term().buffer.active.length = 500
  term().buffer.active.viewportY = 200 // user wheel-scrolled up
  act(() => { term().onScrollListener?.(200) })
  expect(term().scrollToBottom).toHaveBeenCalled()
  expect(term().buffer.active.viewportY).toBe(460)
})

it('does not re-pin on scroll while tail is off', async () => {
  render(leaf())
  await attachResolved()
  term().buffer.active.length = 500
  term().buffer.active.viewportY = 100
  act(() => { term().onScrollListener?.(100) })
  expect(term().scrollToBottom).not.toHaveBeenCalled()
  expect(term().buffer.active.viewportY).toBe(100)
})

it('shows the TAIL pill in the header while tail is active', async () => {
  const view = render(leaf())
  await attachResolved()
  expect(screen.queryByText('TAIL')).toBeNull()
  act(() => { view.rerender(leaf(runtimeWith({ tailMode: true }))) })
  expect(screen.getByText('TAIL')).toBeTruthy()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:renderer -- AgentTerminalLeaf.follow
```
Expected: FAIL — no `onScroll` wiring (first test), no pill (third). Second passes vacuously.

- [ ] **Step 3: Implement re-pin in the hook**

Replace the placeholder `attach` in the `useMemo` handle of `agentTerminalFollow.ts`:

```ts
return useMemo<AgentTerminalFollowHandle>(() => ({
  tailActiveRef,
  attach: mountedTerm => {
    // Feed re-pins on the scroll event itself. scrollToBottom also fires
    // onScroll, but the handler then sees an at-bottom viewport and no-ops,
    // so the loop self-terminates. Mouse-mode TUIs forward wheel events to
    // the app instead of xterm scrollback, so this only acts on genuine
    // viewport movement.
    const disposable = mountedTerm.onScroll(() => {
      if (!tailActiveRef.current) return
      if (isXtermViewportAtBottom(mountedTerm)) return
      mountedTerm.scrollToBottom()
    })
    return () => disposable.dispose()
  },
}), [])
```

- [ ] **Step 4: Implement the TAIL pill in the leaf header**

In `AgentTerminalLeaf.tsx`, replace the header's right-side span (currently the single `terminal view` span):

```tsx
<div className="flex flex-shrink-0 items-center gap-2">
  {tailActive ? (
    <span className="text-[10px] font-code uppercase tracking-wider text-accent">
      TAIL
    </span>
  ) : null}
  <span className="text-[9px] uppercase tracking-wider text-muted">
    terminal view
  </span>
</div>
```

(Styling copied from the TAIL pill in `TileLeaf/ScrollIndicator.tsx` so both surfaces read identically.)

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run test:renderer -- AgentTerminalLeaf.follow
```
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/agentTerminalFollow.ts src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx
git commit -m "feat(workspace): re-pin tailed agent terminals and show TAIL pill"
```

---

### Task 6: Tail All + visibility-mask integration tests

Behavior should already hold (the mask `(runtime.tailMode || tailAllMode) && ownerVisible` landed in Task 2). These tests pin it.

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx`

- [ ] **Step 1: Append the tests** — inside the top-level `describe`:

```tsx
it('follows output when Tail All is on', async () => {
  appStore.tailAllMode = true
  render(leaf())
  await attachResolved()
  expect(screen.getByText('TAIL')).toBeTruthy()
  term().buffer.active.length = 500
  act(() => { ptyListener?.({ sessionId: 'session-1', data: 'stream' }) })
  expect(term().buffer.active.viewportY).toBe(460)
})

it('stays inert for Tail All while the pane subtree is hidden', async () => {
  appStore.tailAllMode = true
  render(
    <AgentTerminalOwnerVisibilityProvider visible={false}>
      {leaf()}
    </AgentTerminalOwnerVisibilityProvider>,
  )
  await attachResolved()
  // Masked: no pill, no forced scroll on output — mirroring TileLeaf's
  // re-reveal argument for folding visibility into the tail mask.
  expect(screen.queryByText('TAIL')).toBeNull()
  term().buffer.active.length = 500
  term().buffer.active.viewportY = 10
  act(() => { ptyListener?.({ sessionId: 'session-1', data: 'stream' }) })
  expect(term().scrollToBottom).not.toHaveBeenCalled()
  expect(term().buffer.active.viewportY).toBe(10)
})
```

- [ ] **Step 2: Run the tests**

```bash
npm run test:renderer -- AgentTerminalLeaf.follow
```
Expected: PASS (13 tests). If either fails, the mask computation in `AgentTerminalLeaf.tsx` deviates from TileLeaf's — fix the mask, not the test.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.follow.renderer.test.tsx
git commit -m "test(workspace): cover Tail All and visibility masking for agent terminals"
```

---

### Task 7: Surface the follow commands on terminal views + copy updates

**Files:**
- Modify: `src/renderer/src/features/workspace/commands/paneCommands.ts`
- Create: `src/renderer/src/features/workspace/commands/paneCommands.follow.renderer.test.ts`

- [ ] **Step 1: Write the failing regression test**

Create `src/renderer/src/features/workspace/commands/paneCommands.follow.renderer.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { paneCommands } from '@renderer/features/workspace/commands/paneCommands'

// Guards the command-availability half of terminal follow: both commands
// previously carried `renderedViewPolicy: 'requires-rendered-feed'`, which
// `commandAllowedByRenderedViewPolicy` resolves to false on ANY terminal
// surface — and unconditionally for OpenCode Terminal sessions
// (providerRuntime === 'terminal'). Someone re-adding the policy "for
// consistency" would silently uninstall the commands from raw terminal views
// again while the leaf-side behavior stays green.
//
// WHY this does not exercise `when`: the kind guards route through
// `commandTargetSessionId`, which needs a much larger workspace-state shape
// (tab/dispatch focus) than a unit fixture should fake. This task does not
// touch `when`; its behavior is owned by the existing command suites.

describe('follow command availability', () => {
  const tail = paneCommands.find(command => command.id === 'toggle-tail')
  const jump = paneCommands.find(command => command.id === 'jump-latest-message')

  it('exposes both follow commands without a rendered-view policy', () => {
    expect(tail).toBeDefined()
    expect(jump).toBeDefined()
    expect(tail!.renderedViewPolicy).toBeUndefined()
    expect(jump!.renderedViewPolicy).toBeUndefined()
  })

  it('keeps both commands shell-excluded through a kind guard', () => {
    // The `when` guards (kind !== 'terminal') are what keep plain shells out;
    // assert they exist so removing the policy cannot silently remove them.
    expect(typeof tail!.when).toBe('function')
    expect(typeof jump!.when).toBe('function')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:renderer -- paneCommands.follow
```
Expected: FAIL on `renderedViewPolicy` being defined.

- [ ] **Step 3: Update `paneCommands.ts`**

`toggle-tail` (around line 486): replace the description, drop the policy line, and update the `when` comment. The block

```ts
    description: '**What it does:** Toggles feed **auto-follow** for the focused target.\n\n**Use when:** You want output to stay pinned to the bottom.\n\n**Notes:** Applies to the visible command target, including **Dispatch** selection.',
    renderedViewPolicy: { kind: 'requires-rendered-feed' },
```

becomes

```ts
    description: '**What it does:** Toggles **auto-follow** for the focused target.\n\n**Use when:** You want output to stay pinned to the bottom.\n\n**Notes:** Applies to the visible command target, including **Dispatch** selection. Works in both the rendered feed and raw agent terminal views — in a terminal view the TUI output stays pinned to the bottom.',
    // NO `renderedViewPolicy` — deliberately: this command owns follow
    // behavior on BOTH agent surfaces now (Feed's tailMode on the rendered
    // surface, useAgentTerminalFollow on the raw terminal). The old
    // 'requires-rendered-feed' gate hid it on terminal surfaces, where
    // following is exactly as meaningful.
```

and the `when` comment

```ts
      // WHY tail is agent-only even though terminals are Dispatch rows:
      // tailMode controls the rendered transcript/feed scroll container.
      // Terminal panes delegate scrollback to xterm.js, so toggling this
      // runtime flag on a terminal would present a command that appears to
      // work while changing nothing visible.
      return workspace.state.sessions[sessionId]?.kind !== 'terminal'
```

becomes

```ts
      // WHY tail is agent-only even though plain shells are Dispatch rows:
      // agent sessions consume tailMode on both of their surfaces since the
      // terminal-follow work (useAgentTerminalFollow). Plain shell terminals
      // (kind === 'terminal') delegate entirely to xterm scrollback and have
      // no tail state.
      return workspace.state.sessions[sessionId]?.kind !== 'terminal'
```

`toggle-tail-all` (around line 541): in the description, replace

```
Terminals are never affected.
```

with

```
Plain shell terminals are never affected; raw agent terminal views follow too.
```

`jump-latest-message` (around line 556): drop the policy line and update the notes. The block

```ts
    description: '**What it does:** Scrolls to the **latest agent message**.\n\n**Use when:** You are far up in the feed and want to return to the bottom.\n\n**Notes:** Agent panes only.',
    renderedViewPolicy: { kind: 'requires-rendered-feed' },
```

becomes

```ts
    description: '**What it does:** Scrolls to the **latest agent message**.\n\n**Use when:** You are far up in the feed and want to return to the bottom.\n\n**Notes:** Agent panes only — in a raw terminal view this scrolls the TUI viewport to the bottom.',
    // NO `renderedViewPolicy` — the xterm viewport answers jump requests too
    // (useAgentTerminalFollow); gating on a rendered feed would hide this on
    // the surface where returning to the bottom is most often needed.
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test:renderer -- paneCommands.follow
```
Expected: PASS (2 tests).

- [ ] **Step 5: Run the command-related checks (copy changed)**

```bash
npm run check:contract && npm run check:keybindings
```
Expected: both exit 0. If the contract checker objects to the removed fields, read its output — it is the authority on command-def invariants.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/workspace/commands/paneCommands.ts src/renderer/src/features/workspace/commands/paneCommands.follow.renderer.test.ts
git commit -m "feat(workspace): surface follow commands on raw agent terminal views"
```

---

### Task 8: Full verification sweep

**Files:** none

- [ ] **Step 1: Typecheck**

```bash
npm run typecheck
```
Expected: exit 0.

- [ ] **Step 2: Full renderer suite**

```bash
npm run test:renderer
```
Expected: PASS, zero failures — in particular `commandState.test.ts`, `preferences.renderer.test.tsx`, and `agentDisplayMode.test.ts` (policy semantics were touched indirectly).

- [ ] **Step 3: Unit + system suites**

```bash
npm run test:unit && npm run test:system
```
Expected: PASS.

- [ ] **Step 4: Review the final diff**

```bash
git diff main --stat && git log --oneline main..
```
Expected: only the files listed in this plan; conventional-commit subjects; plan file is the first commit.

- [ ] **Step 5: Report and wait**

Report the final state (tests run, results, remaining risks — e.g. alternate-screen TUIs make follow a visual no-op by design; behavior verified against mocked xterm scroll APIs, not a real canvas) and wait for explicit user confirmation before opening a PR. Do not merge.
