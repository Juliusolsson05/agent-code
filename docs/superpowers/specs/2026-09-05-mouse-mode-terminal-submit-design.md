# Mouse Mode Submit for Agent Terminal Panes — Design

**Date:** 2026-09-05
**Branch:** `feat/mouse-mode-terminal-submit`
**Status:** Approved for implementation planning
**Issue:** #819
**Follows:** `docs/superpowers/plans/2026-07-28-mouse-first-workspace.md` (PR #617, IMPLEMENTED)

## Problem

Mouse Mode (`mouseModeEnabled`) gates a pointer-clickable **Send** and **Stop** row, but only inside the rendered feed (`ComposerActions` in `TileLeaf.tsx:1021-1047`). When an agent runs in **Terminal view** — `AgentTerminalLeaf` (Claude/Codex TUI, and the OpenCode Terminal runtime where `providerRuntime === 'terminal'`) — there is no composer and therefore no Send, Stop, or any other mouse-reachable way to press Enter.

The concrete failure: a mouse-only user dictates or pastes a command into the raw agent PTY, then has no way to submit it. Dictation deliberately does **not** auto-submit — `useComposerDictation.ts:334` wraps the final text in bracketed-paste and the user is expected to press Enter. A mouse-only user has no path to that final Enter without the keyboard.

This is exactly the W5 gap the mouse audit found in the feed ("a mouse user can't interrupt"), carried over into terminal view: **a mouse user can't submit**.

## Scope

- **In scope:** `AgentTerminalLeaf` only. When `mouseModeEnabled` is on, render a thin **Submit** action row below the xterm box. Clicking it sends the Enter byte (`'\r'`) to the agent PTY.
- **Explicitly out of scope:**
  - **`TerminalLeaf` (plain shell panes, OpenCode shell sessions) — untouched.** Requirement from the user's directive: preserve ordinary shell behavior. Shells keep zero controls. The gap is specifically that *agents* in terminal view lose their composer affordances; a plain shell never had a Send button to lose.
  - **A Stop button.** Interrupt semantics differ per TUI (Escape vs Ctrl+C vs internal protocol) and need their own verification pass. Deliberately deferred.
  - **Any new setting.** `mouseModeEnabled` is reused. Off = row not mounted = zero layout change.

## Design

### Behavior: Submit is a hardware-Enter, nothing more

The Submit button sends exactly the byte the Enter key produces for xterm: `'\r'` (`AgentTerminalLeaf` creates xterm with `convertEol: false`, so Enter is CR). It is routed through the **same** outgoing path as a real keypress — the `terminalInputForwarder` (#745) and its pre-attach queue — making it byte-for-byte identical to pressing Enter. Rationale:

- A raw PTY has no readable "current line" (the live buffer lives inside the TUI), so there is nothing to disable against and nothing to read back. The button is always enabled, exactly like a hardware Enter key. This mirrors ComposerActions' "The button must not be more conservative than Enter" rule (`ComposerActions.tsx:60-68`).
- Because it rides the existing forwarder, all the derived invariants hold for free: bytes typed during replay are dropped (the ~100ms attach parse window), bytes before attach are queued in `pendingInput` and flushed on attach, and same-tick coalescing applies. Hand-building a direct `window.api.sendInput(sessionId, '\r')` would skip all three and make the button *more* powerful (or lossy) than the key.
- It must never touch `runtime.draftInput`, compose state, or feed state. Terminal view has no draft by design (`AgentTerminalLeaf.tsx:41-44` — it "deliberately bypasses the Agent Code feed/composer stack"); we are not inventing one.

### Focus and engagement

The button's `onMouseDown` does `event.preventDefault()` (the ComposerActions rule), so DOM focus never leaves the terminal. But it does **not** stop bubbling: the outer `AgentTerminalLeaf` div's captured `onMouseDown` (`AgentTerminalLeaf.tsx:453-457`) already handles `onFocusRequest()`, `acknowledgeSession`, and `focusTerminal()`, so clicking Submit re-focuses xterm and marks the session engaged — and a subsequent click delivers the Enter against a freshly focused xterm. No extra wiring needed.

### Gating

`const mouseModeEnabled = useAppStore(state => state.settings.mouseModeEnabled)` — the same selector TileLeaf uses (`TileLeaf.tsx:211`). Rendered as:

```tsx
{mouseModeEnabled ? <AgentTerminalActions onSubmit={() => submitEnterRef.current()} /> : null}
```

mounted **below** the xterm box and **above** `<PaneToast>`, mirroring ComposerActions' below-the-surface placement.

### The ref that carries the Enter path

The forwarder, `pendingInput`, and `attachedBackfillDone` live inside the mount effect's closure (keyed on `sessionId`). The click handler lives in JSX. To bridge them without remounting xterm, the effect publishes a stable closure on a ref:

```tsx
const submitEnterRef = useRef<() => void>(() => {})
```

set inside the effect right after the forwarder is created:

```tsx
submitEnterRef.current = () => {
  if (forwarder.replaying) return
  if (!attachedBackfillDone) {
    pendingInput.push('\r')
    return
  }
  forwarder.onData('\r')
}
```

This is the exact three-way decision `onData` makes in the existing keypress handler.

### New component

`src/renderer/src/workspace/tile-tree/AgentTerminalActions.tsx` — a self-contained row so the surface stays readable, mirroring how `ComposerActions` and `PaneToast` are extracted. Reuses Send's row tokens (`border-t border-border bg-surface px-3 py-1.5`) and button tokens (`rounded-control border border-control-border bg-control-active-bg px-3 py-1 text-[11px] leading-none text-control-active-fg hover:bg-control-hover-bg`) so the two submit affordances read as the same control. Label: **Submit** (not Send — there is no text to send, and the design doc keeps the verb honest about what the byte does).

### Accept-it-ship-it trace to the mouse-first relationship

Mouse-first deliberately left terminal view out (its ComposerActions row sits inside TileLeaf and the plan fans out the same affordances there). This is the follow-up that closes the same gap for the `'terminal'` agent view mode (`EffectiveAgentSurface` in `agentDisplayMode.ts`).

## Testing strategy

Colocated renderer tests only, matching the suite's conventions (`testing/` is not the default; tests sit next to sources):

1. `AgentTerminalActions.renderer.test.tsx` — component contract: renders, `mousedown` prevents default (focus preservation), `click` fires `onSubmit` once. Mirrors `PaneToast.renderer.test.tsx`'s style.
2. `AgentTerminalLeaf.submit.renderer.test.tsx` — full-mount wiring test using the xterm-mock harness pattern from `AgentTerminalLeaf.dimensionOwnership.renderer.test.tsx`:
   - mouse mode on → button renders; **after** attach completes, clicking it calls `window.api.sendInput(sessionId, '\r')` (proves the byte and the routing).
   - mouse mode off → button is absent (`queryByRole` null). This is the acceptance test for "ordinary shell behavior preserved by not mounting" on the agent side.
   - click **before** attach resolves → Enter is queued and flushed once attach lands (proves byte-for-byte equality with a keypress in the pre-attach window).

## Acceptance criteria

- [ ] `AgentTerminalActions` + colocated renderer tests land.
- [ ] Full-leaf wiring test proves the click sends `'\r'`, is absent when mouse mode is off, and queues pre-attach.
- [ ] `TerminalLeaf.tsx` and `ComposerActions.tsx` are byte-identical after this change.
- [ ] `npm run typecheck` and `npm run test:renderer` pass under Node 24 (the `.nvmrc`/CI version; happy-dom's `localStorage` is broken under Node 25 — see plan Verification section).
- [ ] Open reviewable PR referencing #819; **do not merge** without user confirmation.