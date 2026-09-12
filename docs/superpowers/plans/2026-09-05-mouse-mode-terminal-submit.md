# Mouse Mode Submit for Agent Terminal Panes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Mouse Mode-gated Submit button to `AgentTerminalLeaf` that sends the Enter byte (`'\r'`) to the agent PTY through the existing keypress pipeline — no new setting, no layout change when off, plain shells untouched.

**Architecture:** A self-contained `AgentTerminalActions` row component is mounted in `AgentTerminalLeaf` only when `mouseModeEnabled`. Its click routes through a ref published by the mount effect that mirrors the existing `onData` keypress path (`forwarder` + pre-attach `pendingInput` queue), so a mouse click and a real Enter are byte-identical to the backend.

**Tech Stack:** React (renderer), xterm + `terminalInputForwarder` (#745), the existing zustand settings store (`mouseModeEnabled`), Vitest renderer project (happy-dom).

**Related:** Issue #819; design doc `docs/superpowers/specs/2026-09-05-mouse-mode-terminal-submit-design.md`; mouse-first plan PR #617.

> **Where the implementation diverged from this plan**, so the next reader trusts the code over the doc:
>
> - **The focus test asserts `defaultPrevented` via a dispatched native `MouseEvent`, not `fireEvent`'s return value.** RTL's synthetic mouse-down object reports `undefined` for `defaultPrevented` after React processes the handler in this happy-dom setup. The component behavior is unchanged.
> - **`AgentTerminalActions.renderer.test.tsx` imports `act`** for that dispatched event; everything else matches the plan verbatim.

---

## Environment note (read first)

This machine's default node is `v25.5.0`. happy-dom 20.9.0's `localStorage` is broken under Node 25 (`storage.setItem is not a function` — 34 renderer tests fail). CI and `.nvmrc` pin **Node 24**. Every test/typecheck command below MUST run with the override:

```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
```

Verify with `node --version` → `v24.14.1`.

All work happens in the worktree `.worktrees/mouse-mode-terminal-submit` on `feat/mouse-mode-terminal-submit`. Submodules are checked out and `npm install` has run (baseline: 121 renderer files / 514 tests passing).

---

### Task 1: `AgentTerminalActions` component (test-first)

**Files:**
- Create: `src/renderer/src/workspace/tile-tree/AgentTerminalActions.tsx`
- Test: `src/renderer/src/workspace/tile-tree/AgentTerminalActions.renderer.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/workspace/tile-tree/AgentTerminalActions.renderer.test.tsx`:

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { AgentTerminalActions } from './AgentTerminalActions'

describe('AgentTerminalActions', () => {
  it('renders exactly one always-enabled Submit button', () => {
    render(<AgentTerminalActions onSubmit={() => {}} />)
    const button = screen.getByRole('button', { name: 'Submit' })
    expect(button).not.toBeDisabled()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('prevents default on mousedown so xterm keeps focus', () => {
    render(<AgentTerminalActions onSubmit={() => {}} />)
    const button = screen.getByRole('button', { name: 'Submit' })
    // Dispatch a real cancelable mousedown rather than relying on fireEvent's
    // return value: RTL's synthetic object does not reflect defaultPrevented
    // after React processes the handler in this environment.
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => { button.dispatchEvent(mousedown) })
    expect(mousedown.defaultPrevented).toBe(true)
  })

  it('still lets mousedown bubble so the owning leaf engages the session', () => {
    const onMouseDown = vi.fn()
    render(
      <div onMouseDown={onMouseDown}>
        <AgentTerminalActions onSubmit={() => {}} />
      </div>,
    )
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Submit' }))
    expect(onMouseDown).toHaveBeenCalledTimes(1)
  })

  it('fires onSubmit once per click', () => {
    const onSubmit = vi.fn()
    render(<AgentTerminalActions onSubmit={onSubmit} />)
    const button = screen.getByRole('button', { name: 'Submit' })
    fireEvent.mouseDown(button)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onSubmit).toHaveBeenCalledTimes(2)
  })

  it('uses the composer control scaffold', () => {
    const { container } = render(<AgentTerminalActions onSubmit={() => {}} />)
    const button = screen.getByRole('button', { name: 'Submit' })
    expect(button.className).toContain('rounded-control')
    expect(button.className).toContain('control-active-bg')
    expect(container.firstElementChild!.className).toContain('border-t')
    expect(container.firstElementChild!.className).toContain('bg-surface')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
npx vitest run --project renderer AgentTerminalActions
```
Expected: FAIL — module `./AgentTerminalActions` not found (every test fails to import).

- [ ] **Step 3: Write the minimal implementation**

Create `src/renderer/src/workspace/tile-tree/AgentTerminalActions.tsx`:

```tsx
import type { JSX } from 'react'

// AgentTerminalActions — pointer-clickable Submit for raw agent terminals,
// shown only in Mouse Mode, the terminal-view sibling of ComposerActions.
//
// WHY it exists: AgentTerminalLeaf is a pure PTY view with no composer and no
// draft, so the one thing a mouse-only user is missing is the final Enter
// after dictating or pasting a command into the TUI (dictation intentionally
// never auto-submits — the user reviews, then presses Enter). This row is
// that Enter, nothing more.
//
// WHY it is behind a setting although the row is tiny: same logic as
// ComposerActions. It costs a row of pane height in EVERY agent pane, and a
// keyboard user submits with Enter and gets nothing from it. Mouse mode makes
// the trade worth taking.
//
// WHY Submit is never disabled: the raw PTY's current line lives inside the
// provider's TUI, so there is nothing to read back and nothing to gate on.
// The button must be exactly as conservative as a hardware Enter key — always
// available. This is ComposerActions' "must not be more conservative than
// Enter" rule applied to a surface without a draft.
//
// WHY the row lives in AgentTerminalLeaf and is NOT shared with TerminalLeaf:
// ordinary shells are explicitly out of scope for this feature (issue #819).
// A plain shell pane never had a Send affordance to lose; mounting controls
// there would only add chrome to panes that must stay untouched.

export type AgentTerminalActionsProps = {
  /** Sends the Enter byte to the agent PTY. */
  onSubmit: () => void
}

export function AgentTerminalActions({ onSubmit }: AgentTerminalActionsProps): JSX.Element {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-3 py-1.5">
      <button
        type="button"
        // preventDefault keeps DOM focus out of this button: a focused button
        // would pull keystrokes away from xterm — the very thing this control
        // exists to complement. Deliberately NOT stopPropagation: the owning
        // leaf's own onMouseDown must still acknowledge and re-focus xterm.
        onMouseDown={event => event.preventDefault()}
        onClick={onSubmit}
        className="rounded-control border border-control-border bg-control-active-bg px-3 py-1 text-[11px] leading-none text-control-active-fg hover:bg-control-hover-bg"
      >
        Submit
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
npx vitest run --project renderer AgentTerminalActions
```
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/AgentTerminalActions.tsx \
        src/renderer/src/workspace/tile-tree/AgentTerminalActions.renderer.test.tsx
git commit -m "feat(terminal): add Mouse Mode Submit button component (#819)"
```

---

### Task 2: Wire Submit into `AgentTerminalLeaf` (test-first)

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx` (add selector at the top of the component near `dictationEnabled`; add `submitEnterRef` next to the other refs; set the ref inside the mount effect right after the forwarder is created; mount the row above `<PaneToast>`)
- Test: `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.submit.renderer.test.tsx`

- [ ] **Step 1: Inspect the test harness to copy**

Read `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.dimensionOwnership.renderer.test.tsx` in full. The new file reuses its xterm/addon-fit/webgl/theme/dictation mocks and its `api`/`workspace` shapes, with one difference: `useAppStore` must expose **`mouseModeEnabled`** from a mutable holder so the tests can flip it.

- [ ] **Step 2: Write the failing full-mount wiring test**

Create `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.submit.renderer.test.tsx`:

```tsx
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyRuntime } from '@renderer/session-runtime/state'
import {
  AgentTerminalOwnershipProvider,
  MountedAgentTerminalOwner,
} from '@renderer/workspace/terminal/AgentTerminalOwnership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { AgentTerminalLeaf } from './AgentTerminalLeaf'

type MockTerminal = Record<string, unknown> & {
  cols: number
  rows: number
  container: HTMLElement | null
  onDataListener: ((data: string) => void) | null
}

const xtermHarness = vi.hoisted(() => ({
  cols: 120,
  rows: 40,
  instances: [] as MockTerminal[],
  attachWebgl: vi.fn(),
  fit: vi.fn(),
}))

const settings = vi.hoisted(() => ({
  dictationEnabled: false,
  dictationProvider: 'local',
  dictationShortcut: 'off',
  mouseModeEnabled: false,
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
    dispose = vi.fn()
    inputDispose = vi.fn(() => { this.onDataListener = null })
    constructor() { xtermHarness.instances.push(this as unknown as MockTerminal) }
    loadAddon() {}
    open(container: HTMLElement) { this.container = container }
    onData(listener: (data: string) => void) {
      this.onDataListener = listener
      return { dispose: this.inputDispose }
    }
    write(_data: string, callback?: () => void) { callback?.() }
    focus() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class { fit() { xtermHarness.fit() } },
}))

vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings }),
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

describe('AgentTerminalLeaf Mouse Mode Submit', () => {
  let attach: Deferred<string | null>
  let nextFrameId: number
  let frames: Map<number, FrameRequestCallback>
  const resize = vi.fn().mockResolvedValue(undefined)
  const sendInput = vi.fn().mockResolvedValue(undefined)
  const api = {
    attachAgentPty: vi.fn((_id: string) => attach.promise),
    detachAgentPty: vi.fn().mockResolvedValue(undefined),
    onSessionAgentPtyData: vi.fn(() => () => {}),
    onSessionTerminalData: vi.fn(() => () => {}),
    resize,
    sendInput,
  }
  const workspace = {
    acknowledgeSession: vi.fn(),
    ensureSessionLive: vi.fn().mockResolvedValue(undefined),
    showPaneToast: vi.fn(),
  } as unknown as Workspace

  function flushAnimationFrames() {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(performance.now())
  }

  function leaf() {
    return (
      <AgentTerminalOwnershipProvider>
        <MountedAgentTerminalOwner sessionId="session-1">
          <AgentTerminalLeaf
            sessionId="session-1"
            focused
            onFocusRequest={() => {}}
            workspace={workspace}
            runtime={{ ...emptyRuntime(), processStatus: 'started' }}
            projectDir="/tmp/project"
            provider="codex"
          />
        </MountedAgentTerminalOwner>
      </AgentTerminalOwnershipProvider>
    )
  }

  beforeEach(() => {
    settings.mouseModeEnabled = false
    attach = deferred<string | null>()
    nextFrameId = 0
    frames = new Map()
    xtermHarness.fit.mockClear()
    xtermHarness.instances.length = 0
    xtermHarness.attachWebgl.mockReset()
    xtermHarness.attachWebgl.mockImplementation(() => ({
      ready: Promise.resolve(true),
      dispose: vi.fn(),
    }))
    api.attachAgentPty.mockReset().mockImplementation(() => attach.promise)
    api.detachAgentPty.mockClear()
    resize.mockClear()
    sendInput.mockClear()
    workspace.acknowledgeSession = vi.fn()

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

  it('hides Submit entirely when Mouse Mode is off', () => {
    render(leaf())
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
  })

  it('sends the Enter byte to the agent PTY after attach when Mouse Mode is on', async () => {
    settings.mouseModeEnabled = true
    render(leaf())
    act(() => flushAnimationFrames())
    await act(async () => {
      attach.resolve('')
      await attach.promise
    })

    const button = screen.getByRole('button', { name: 'Submit' })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    await act(async () => { await Promise.resolve() })

    expect(sendInput).toHaveBeenCalledWith('session-1', '\r')
  })

  it('queues a pre-attach Submit and delivers it once attach lands', async () => {
    settings.mouseModeEnabled = true
    render(leaf())
    act(() => flushAnimationFrames())
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(sendInput).not.toHaveBeenCalled()

    await act(async () => {
      attach.resolve('')
      await attach.promise
    })
    expect(sendInput).toHaveBeenCalledWith('session-1', '\r')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
npx vitest run --project renderer AgentTerminalLeaf.submit
```
Expected: FAIL — `queryByRole(... 'Submit')` matches nothing because the leaf does not render the row yet.

- [ ] **Step 4: Wire the component, byte-routing ref, and gating into the leaf**

Edit `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx`:

1. Import `AgentTerminalActions` next to the other tile-tree imports:

```tsx
import { AgentTerminalActions } from '@renderer/workspace/tile-tree/AgentTerminalActions'
```

2. Add the Mouse Mode selector next to the `dictation*` selectors inside the component (after the `dictationShortcut` line, ~line 63):

```tsx
const mouseModeEnabled = useAppStore(state => state.settings.mouseModeEnabled)
```

3. Add the ref next to `showPaneToastRef`:

```tsx
// Published by the mount effect (which owns the forwarder and pre-attach
// queue) so the Mouse Mode Submit button can inject Enter exactly as the
// Enter key would. A no-op until the effect has run; the effect always re-runs
// on (re)mount and overwrites it.
const submitEnterRef = useRef<() => void>(() => {})
```

4. Inside the mount effect, immediately after the forwarder is created (the `const forwarder = createTerminalInputForwarder(...)` block, ~line 244-246), publish the routing closure:

```tsx
      // WHY the Submit button reuses the keypress pipeline instead of calling
      // window.api.sendInput directly: the leaf only forwards keystrokes AFTER
      // attach (pendingInput) and only outside the replay window (the
      // forwarder latch). A direct call would skip both, so its Enter could
      // hit the provider before the PTY exists or while xterm is still parsing
      // the attach replay — more powerful than the Enter key it replaces. Pushing
      // '\r' down the same path keeps a mouse click and a real keypress
      // indistinguishable to the backend. '\r' is xterm's Enter byte here
      // because this terminal is created with convertEol: false above.
      submitEnterRef.current = () => {
        if (forwarder.replaying) return
        if (!attachedBackfillDone) {
          pendingInput.push('\r')
          return
        }
        forwarder.onData('\r')
      }
```

5. Mount the row between the terminal box and `<PaneToast>` (replace the `<PaneToast .../>` opening context — insert the gated row immediately before it):

```tsx
      {/* Mouse Mode only, mirroring ComposerActions' gating in TileLeaf. A raw
          terminal has no composer or draft, so Submit is this surface's only
          action — the Enter byte a keyboard user presses after dictating or
          pasting. Gated on the setting because the row costs pane height in
          every agent pane and a keyboard user gets nothing from it. */}
      {mouseModeEnabled ? (
        <AgentTerminalActions onSubmit={() => submitEnterRef.current()} />
      ) : null}
      <PaneToast message={runtime.paneToast} />
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
npx vitest run --project renderer AgentTerminalLeaf.submit
```
Expected: PASS — 3 tests.

- [ ] **Step 6: Run the rest of the terminal/tile-tree renderer tests to catch regressions**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
npx vitest run --project renderer AgentTerminalLeaf TerminalLeaf ComposerActions
```
Expected: PASS — the dimension-ownership harness (whose `useAppStore` mock does NOT provide `mouseModeEnabled`) still passes, proving the new selector degrades to `undefined` (falsy) safely.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx \
        src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.submit.renderer.test.tsx
git commit -m "feat(terminal): submit Enter to agent PTY in Mouse Mode (#819)"
```

---

### Task 3: Full verification, PR

**Files:** none (read-only checks + git operations)

- [ ] **Step 1: Confirm the out-of-scope files are byte-identical**

Run:
```bash
git diff --stat main -- src/renderer/src/workspace/tile-tree/TerminalLeaf.tsx \
  src/renderer/src/workspace/tile-tree/TileLeaf/ComposerActions.tsx
```
Expected: empty output (no diff).

- [ ] **Step 2: Typecheck**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
npm run typecheck
```
Expected: completes without errors (tsc `-b` across the project).

- [ ] **Step 3: Full renderer suite**

Run:
```bash
export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"
npm run test:renderer
```
Expected: 123 test files pass, 0 failures (121 baseline + the two new files `AgentTerminalActions.renderer.test.tsx` and `AgentTerminalLeaf.submit.renderer.test.tsx`, which add 8 tests: 5 + 3).

- [ ] **Step 4: Confirm submodule integrity**

Run:
```bash
node scripts/verify-submodule-checkouts.mjs
```
Expected: `Verified 6 pinned submodule checkouts.`

- [ ] **Step 5: Self-review the diff**

Run:
```bash
git diff main --stat
git diff main -- src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx
```
Review: only the 5 edit sites from Task 2 changed in the leaf; no other files touched.

- [ ] **Step 6: Push and open the PR**

Run:
```bash
git log --oneline main..HEAD
git push -u origin feat/mouse-mode-terminal-submit
gh pr create --repo Juliusolsson05/agent-code \
  --title "feat(terminal): Mouse Mode Submit button for agent terminal panes (#819)" \
  --body "Closes #819. Adds a Mouse Mode-gated Submit row to AgentTerminalLeaf that sends the Enter byte (\\'\\r\\') to the agent PTY through the existing keypress pipeline. See plan docs/superpowers/plans/2026-09-05-mouse-mode-terminal-submit.md." \
  --base main
```
Expected: PR opened. **Do not merge** — the user must confirm first.