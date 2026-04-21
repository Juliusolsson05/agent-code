# HTML Debug Panel — Design Spec

A fourth side-rail debug panel that captures and copies the rendered HTML of the currently focused pane. Used during rendering debugging to grab a raw `outerHTML` snapshot of a `TileLeaf` — structure, text content, and Tailwind classes exactly as React produced them — for inspection or for pasting into an LLM / scratch HTML file.

## Why

Rendering bugs in the Feed, composer, picker overlays, and status strips are hard to describe in prose. Being able to say "here is exactly the DOM the app is painting for this pane right now" — as a copy-pasteable string — short-circuits that problem. We already have three diagnostic side rails (`DebugPanel`, `FeedDebugPanel`, `ProxyDebugPanel`) but none expose the rendered DOM itself.

This is explicitly a **rendering debug aid**, not an export feature. Unstyled output is fine — the goal is to see the structure React produced, not to visually reproduce the pane elsewhere.

## What's In Scope

- A new side-rail panel `HtmlDebugPanel.tsx` that matches the existing three panels' chrome and placement.
- A command palette entry "Toggle HTML Debug Panel" alongside the existing debug-panel toggles.
- Store fields `htmlDebugPanelOpen: boolean` and `toggleHtmlDebugPanel()` matching the existing pattern in `commands/types.ts:32-34`.
- A `data-pane-id={sessionId}` attribute on the `TileLeaf` root `<div>` so the panel can locate the focused pane's DOM node.
- A "Refresh" action that re-snapshots the DOM on demand.
- A "Copy" action that writes the full snapshot to the clipboard via `navigator.clipboard.writeText` and surfaces a `paneToast` confirmation.

## What's Explicitly Out Of Scope

- No pretty-printing or HTML formatting. Raw `outerHTML` exactly as the browser serializes it.
- No CSS inlining, no stylesheet bundling, no "looks identical when pasted" mode.
- No whole-tab or whole-app scope — focused pane only.
- No live / auto-refreshing preview. Snapshot on open; manual refresh otherwise.
- No dedicated keyboard shortcut. Palette only, matching the other debug panels.
- No mutual exclusivity with the other debug panels. They stack, same as the existing three do today.

## Architecture

### Capture mechanism

Add `data-pane-id={sessionId}` to the `TileLeaf` root `<div>` (currently at `TileLeaf.tsx:886`). The debug panel reads the focused session ID from the active tab (same source the other three panels use — `activeTab.focusedSessionId`) and does:

```ts
const node = document.querySelector(`[data-pane-id="${sessionId}"]`)
const html = node?.outerHTML ?? ''
```

**Why a data attribute instead of a React ref:**

- The existing three debug panels are stateless about the DOM. They all work off `runtime` props, never reach through refs into `TileLeaf`. Staying on that pattern keeps the boundary consistent.
- A stable `data-pane-id` is also useful for any future DOM-targeting debug or automation work, so paying the tiny plumbing cost once has compound value.
- A ref would require hoisting a `Map<SessionId, HTMLDivElement>` up to the workspace level and threading it into every `TileLeaf` and every panel that might want to read it. That's a lot of plumbing for a feature that only needs `querySelector`.

### Snapshot timing

The preview is a **frozen snapshot**, not live-bound to DOM mutations.

- Captured when the panel mounts (i.e., when the user toggles it open).
- A "Refresh" button in the panel header re-runs the capture.
- No `MutationObserver`, no polling. Rendering a live multi-KB string into a `<pre>` on every keystroke, scroll tick, or stream delta would reflow React needlessly and produce a noisy moving-target preview that's worse for debugging than a clean snapshot.

### Panel UI

Same visual treatment as the existing debug panels: 380px fixed-width side rail, `bg-[#0c0c0c]`, red uppercase header, `text-[10px] font-code` body.

Header row (left-to-right):
- Title: `debug — html (<kind>)`
- Action buttons: `↻ refresh`, `copy`, `×` close

Body:
- **Meta line**: `N chars · K KB · captured HH:MM:SS` — the copy button writes the stored full string regardless of what's rendered in the preview, so this line is the ground truth for what "copy" will produce.
- **Preview**: a scrollable `<pre>` with `whitespace-pre-wrap break-all` showing the full snapshot as text.

**Preview size handling:** start without a render cap. If long-history panes (tens of thousands of feed entries) cause hitches when React commits the `<pre>` text, add a render cap at ~50 KB with a "showing first 50 KB of N KB (copy for full)" banner — the copy action keeps writing the full string from state. This is a tune-up if needed, not upfront work.

### Copy action

```ts
await navigator.clipboard.writeText(html)
workspace.setPaneToast(focusedSessionId, `Copied pane HTML (${formatSize(html)})`)
```

Uses the existing per-pane toast machinery (`workspaceStore.ts:4272-4284`, `runtime.paneToast`, rendered in `TileLeaf.tsx:1071-1086`). No new toast surface. Failure path: if `writeText` throws, set a toast `"Copy failed: <message>"` for the same ~1.6s window.

### Command wiring

Add to the app store (the same store that already exposes `toggleDebugPanel`, `toggleFeedDebugPanel`, `toggleProxyDebugPanel`):

```ts
htmlDebugPanelOpen: boolean
toggleHtmlDebugPanel(): void
```

Thread into `CommandPalette.tsx` alongside the existing three (lines 46-90, 163-203) as "Toggle HTML Debug Panel". Render branch in `App.tsx:235-259` as a fourth block mirroring `DebugPanel`. No new IPC, no main-process work.

## File Plan

| File | Change |
|---|---|
| `src/renderer/src/HtmlDebugPanel.tsx` | **new** — the panel component |
| `src/renderer/src/tiles/TileLeaf.tsx` | add `data-pane-id={sessionId}` on the root `<div>` at line 886 |
| `src/renderer/src/App.tsx` | import + render `HtmlDebugPanel`, pass `toggleHtmlDebugPanel` + `htmlDebugPanelOpen` into `CommandPalette` |
| `src/renderer/src/CommandPalette.tsx` | add one palette entry, accept the new toggle + open flag in props |
| `src/renderer/src/commands/types.ts` | add `toggleHtmlDebugPanel` and `htmlDebugPanelOpen` to the shared types |
| app store (wherever `debugPanelOpen` is defined — discovered during planning) | add field + toggle action mirroring the existing three |

## Component Contract

### `HtmlDebugPanel`

```ts
type Props = {
  sessionId: string    // the focused pane's session id
  kind: string         // provider kind, for header label
  workspace: Workspace // for setPaneToast
  onClose: () => void  // matches the other panels
}
```

**Internal state:**
- `html: string` — the captured snapshot
- `capturedAt: number` — Date.now() of last capture, for the meta line

**Behavior:**
- On mount: capture immediately.
- On refresh click: re-capture.
- On copy click: write `html` to clipboard; toast on success/failure.
- On close: call `onClose`.

**Query target:** `document.querySelector(`[data-pane-id="${sessionId}"]`)`. If the node isn't found (e.g., focus moved to a pane that's been closed), show an empty preview with a meta line reading `no pane found for <sessionId>`.

## Error Handling

- **Pane DOM not found** — show meta line `"no pane found for <sessionId>"`, empty preview, copy button disabled.
- **Clipboard write throws** — catch and render `"Copy failed: <message>"` via the pane toast for ~1.6s. Don't crash the panel.
- **Focused session changes while the panel is open** — the `sessionId` prop changes, React re-renders, and the capture effect re-runs. The panel always reflects the *currently* focused pane, same as the other three do.

## Testing

Manual testing covers this feature adequately; the failure surface is thin (DOM query, `outerHTML`, clipboard write) and the existing debug panels have no automated tests either. Verification steps:

1. Toggle the panel from the command palette — panel mounts, preview shows a multi-KB HTML string that includes the pane's header, feed entries, and composer.
2. Click Copy — paste into a scratch file; confirm the pasted HTML matches what the preview shows.
3. Click Refresh after typing in the composer — preview updates and the meta timestamp advances.
4. Close and reopen the panel with a different pane focused — preview captures the new pane.
5. Confirm the other three debug panels still render correctly when opened simultaneously.

## Risks

- **Preview size hitches** — a very long feed could produce hundreds of KB of HTML. The render-cap fallback documented under "Panel UI" is the mitigation if this shows up in practice. Not prebuilt to keep the MVP minimal.
- **`data-pane-id` collisions** — only set on `TileLeaf` roots, values are session UUIDs. No collision risk.
- **Clipboard permission prompts** — Electron's renderer has `navigator.clipboard.writeText` available without prompts (already used in three places in the codebase). No new permission surface.
