# Copy Assistant Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Copy Assistant Message" command that puts the focused pane into a transient "picker" mode — initially highlighting the most recent assistant entry, with Up/Down to step through prior assistant entries, Enter to copy that turn's text to the clipboard, and Esc to cancel.

**Architecture:** Per-runtime state slot `assistantPicker: { selectedUuid } | null`. Commands + keybinds drive the picker; Feed renders an outline around the selected entry and auto-scrolls when the selection moves off-screen. Entering the picker captures arrow / Enter / Esc keys at the document level so the composer doesn't see them. Copy uses the existing `extractLastAssistantText` family of logic, but parameterized by uuid instead of always-last.

**Tech Stack:** TypeScript, React, existing workspaceStore + Feed + commands registry. No new dependencies.

**Out of scope for v1:**
- Picker mode inside ReaderView (Feed-only for now — ReaderView's own pills already let the user pick a session, and stacking picker semantics on top doubles the surface for marginal gain).
- A dedicated keybind (use the command palette only — chord can be added later in a one-line follow-up).
- Multi-line range selection or sub-message text selection (whole-turn copy only, matching Copy Last Response).
- Visual dimming of non-selected entries (just an outline on the selected one — keeps the change small and avoids reflow surprises in feeds with code blocks).

**Decisions taken (assumptions noted inline so they can be challenged):**
- "Assistant message" = a single ConversationEntry with `type: 'assistant'`. Multi-text-block turns get their text concatenated (same shape as `extractLastAssistantText`'s walk).
- Streaming/in-progress assistant text is NOT in the picker. Only completed entries (already in the runtime's `entries` list). If picker is opened mid-turn, the latest *completed* assistant entry is selected.
- Focused pane only. Picker doesn't follow if the user changes pane focus — it cancels.
- Esc inside picker mode dismisses without copying, regardless of palette/spotlight.
- Copy uses `navigator.clipboard.writeText` and shows the existing `showPaneToast(sessionId, 'Copied to clipboard')` confirmation. Same pattern as the "Copy Last Response" command.

---

## File Structure

### Files to create

```
src/renderer/src/features/copy-assistant/commands/copyAssistantCommands.ts   — Registry entry: "Copy Assistant Message"
src/renderer/src/features/copy-assistant/lib/extractAssistantByUuid.ts       — Pure helper: walk entries, find by uuid, concat text
```

### Files to modify

```
src/renderer/src/tiles/workspaceStore.ts          — Runtime field `assistantPicker`, actions: pickerEnter / pickerMove / pickerConfirm / pickerCancel; helper `assistantUuidsForSession`
src/renderer/src/commands/registry.ts             — Register copyAssistantCommands
src/renderer/src/tiles/useKeybinds.ts             — Capture Up/Down/Enter/Esc when picker is active in the focused pane
src/renderer/src/feed/Feed.tsx                    — Read picker uuid via prop, outline matching EntryRow, auto-scroll into view on selection change
src/renderer/src/tiles/TileLeaf.tsx               — Pipe `pickerSelectedUuid` from runtime into <Feed>
src/renderer/src/copyAssistant.ts                 — Re-export the new uuid extractor for symmetry with extractLastAssistantText (not strictly needed but keeps the family in one place)
```

### Why this split

Keeping picker state in the per-session runtime (not a singleton) is consistent with how every other transient UI state is stored (paneToast, pendingApproval, draftInput). It makes "picker auto-cancels when you switch session" trivial — focus change just updates which sessionId we read from.

The pure extractor lives in its own file so it's testable without booting React, and so the Feed-side rendering doesn't have to import workspaceStore types just to call it. The extractor takes `(entries, uuid) => string | null` — no React, no DOM.

The command file lives under `features/copy-assistant/` so the new feature folder pattern stays consistent (one folder per feature, with `commands/` and optional `ui/`/`lib/` subdirs). No `ui/` for v1 because the picker is rendered inside the existing Feed, not a new component.

---

## Pre-flight

Confirm these are unchanged from the current state:

- `workspaceStore.ts:711` — `getRuntime(sessionId): SessionRuntime`
- `workspaceStore.ts:711` neighborhood — `toggleTailMode` (proves the per-runtime mutation pattern this plan reuses)
- `Feed.tsx:628` — the `visible.map((e, i) => …)` rendering loop — this is where the picker outline gets applied
- `useKeybinds.ts:76-90` — the Esc-first/Spotlight/Reader handler block (picker Esc handler goes alongside)
- `paneCommands.ts` exports the `copy-last-assistant` command — the new picker command sits next to it conceptually but lives in its own file under `features/copy-assistant/`

---

## Task 1: Pure extractor for assistant text by uuid

**Files:**
- Create: `src/renderer/src/features/copy-assistant/lib/extractAssistantByUuid.ts`
- Modify: `src/renderer/src/copyAssistant.ts` (re-export)

- [ ] **Step 1: Create the extractor**

Create `src/renderer/src/features/copy-assistant/lib/extractAssistantByUuid.ts`:

```ts
// Pure helper — walk a transcript entry list, find the assistant
// entry whose uuid matches, return its concatenated text content.
//
// Mirrors extractLastAssistantText's text concatenation logic but
// parameterized by uuid instead of always-last. Returns null when
// the uuid doesn't match an assistant entry or when the entry has
// no text content (only tool_use blocks, etc.).
//
// Pure: no React, no DOM, no IO. Trivially unit-testable.

import type { Entry } from '../../../../../shared/types/transcript'

type AssistantMessage = {
  role?: string
  content?: unknown
}

export function extractAssistantByUuid(
  entries: readonly Entry[],
  uuid: string,
): string | null {
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    if ((entry as { uuid?: string }).uuid !== uuid) continue

    const msg = (entry as { message?: AssistantMessage }).message
    if (!msg || msg.role !== 'assistant') return null

    if (typeof msg.content === 'string') {
      const trimmed = msg.content.trim()
      return trimmed || null
    }

    if (Array.isArray(msg.content)) {
      const parts: string[] = []
      for (const block of msg.content) {
        const b = block as { type?: string; text?: string }
        if (b.type === 'text' && typeof b.text === 'string') {
          const t = b.text.trim()
          if (t) parts.push(t)
        }
      }
      return parts.length > 0 ? parts.join('\n\n') : null
    }

    return null
  }
  return null
}

/**
 * Return the uuids of every assistant entry in the list, in order.
 * Used by the picker to know which uuids to step between on
 * Up/Down. Skips entries that have no text content (defensive —
 * those couldn't be copied anyway).
 */
export function assistantUuidsWithText(
  entries: readonly Entry[],
): string[] {
  const out: string[] = []
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const uuid = (entry as { uuid?: string }).uuid
    if (typeof uuid !== 'string') continue
    if (!extractAssistantByUuid(entries, uuid)) continue
    out.push(uuid)
  }
  return out
}
```

- [ ] **Step 2: Re-export from copyAssistant.ts so callers find the family in one place**

Open `src/renderer/src/copyAssistant.ts`. Append to the end:

```ts
export { extractAssistantByUuid, assistantUuidsWithText } from './features/copy-assistant/lib/extractAssistantByUuid'
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/features/copy-assistant/lib/extractAssistantByUuid.ts src/renderer/src/copyAssistant.ts
git commit -m "feat(copy-assistant): pure helpers — extract assistant text by uuid; list assistant uuids with text"
```

---

## Task 2: Workspace runtime state + actions

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts`

- [ ] **Step 1: Add the runtime field**

Open `src/renderer/src/tiles/workspaceStore.ts`. Find the `SessionRuntime` type (search for `pendingCompaction:`). Add the new field after `tailMode`:

```ts
  /** Force the feed to stay pinned to newest output, like tail -f. */
  tailMode: boolean
  /**
   * "Copy Assistant Message" picker state. Null when the picker is
   * not active. When active, holds the uuid of the currently
   * highlighted assistant entry. Up/Down move it; Enter copies +
   * clears; Esc clears.
   *
   * Per-runtime so switching sessions naturally drops the picker.
   */
  assistantPicker: { selectedUuid: string } | null
}
```

- [ ] **Step 2: Initialize the field in emptyRuntime**

Find `const emptyRuntime = (): SessionRuntime => ({` and add the field after `tailMode: false,`:

```ts
  tailMode: false,
  assistantPicker: null,
})
```

- [ ] **Step 3: Add the four picker actions**

Find the `toggleTailMode` callback (search for `const toggleTailMode = useCallback`). Insert the four picker actions immediately after it:

```ts
  // ---- Copy Assistant picker actions ----
  //
  // pickerEnter      — toggles the picker on/off. On entry, picks
  //                    the most-recent assistant entry with text.
  //                    No-op (picker stays null) if the session has
  //                    no assistant entries with text yet.
  // pickerMove       — direction is +1 (Down → newer) or -1 (Up →
  //                    older). Walks the assistantUuidsWithText
  //                    list; clamps at the ends rather than wrapping
  //                    (less surprising, matches macOS list pickers).
  // pickerConfirm    — copies the selected entry's text to clipboard,
  //                    shows a pane toast, clears the picker.
  // pickerCancel     — clears the picker without copying.
  const pickerEnter = useCallback((sessionId: SessionId) => {
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
      if (current.assistantPicker) {
        // Toggle off if already open
        return {
          ...prev,
          [sessionId]: { ...current, assistantPicker: null },
        }
      }
      const uuids = assistantUuidsWithText(current.entries)
      if (uuids.length === 0) return prev
      return {
        ...prev,
        [sessionId]: {
          ...current,
          assistantPicker: { selectedUuid: uuids[uuids.length - 1] },
        },
      }
    })
  }, [])

  const pickerMove = useCallback(
    (sessionId: SessionId, direction: -1 | 1) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const picker = current.assistantPicker
        if (!picker) return prev
        const uuids = assistantUuidsWithText(current.entries)
        if (uuids.length === 0) return prev
        const idx = uuids.indexOf(picker.selectedUuid)
        if (idx === -1) {
          // Selected uuid disappeared (rare — entry was reset?).
          // Snap to the last one.
          return {
            ...prev,
            [sessionId]: {
              ...current,
              assistantPicker: { selectedUuid: uuids[uuids.length - 1] },
            },
          }
        }
        const nextIdx = Math.max(0, Math.min(uuids.length - 1, idx + direction))
        if (nextIdx === idx) return prev
        return {
          ...prev,
          [sessionId]: {
            ...current,
            assistantPicker: { selectedUuid: uuids[nextIdx] },
          },
        }
      })
    },
    [],
  )

  const pickerConfirm = useCallback(
    async (sessionId: SessionId) => {
      const current = latestRuntimesRef.current[sessionId]
      if (!current?.assistantPicker) return
      const text = extractAssistantByUuid(
        current.entries,
        current.assistantPicker.selectedUuid,
      )
      // Clear the picker first so the UI returns to normal even if
      // the clipboard write fails (rare — only with a permission
      // denial, which we surface via toast).
      setRuntimes(prev => {
        const c = prev[sessionId]
        if (!c) return prev
        return { ...prev, [sessionId]: { ...c, assistantPicker: null } }
      })
      if (!text) {
        showPaneToast(sessionId, 'Nothing to copy')
        return
      }
      try {
        await navigator.clipboard.writeText(text)
        showPaneToast(sessionId, 'Copied assistant message')
      } catch {
        showPaneToast(sessionId, 'Clipboard write failed')
      }
    },
    [showPaneToast],
  )

  const pickerCancel = useCallback((sessionId: SessionId) => {
    setRuntimes(prev => {
      const c = prev[sessionId]
      if (!c?.assistantPicker) return prev
      return { ...prev, [sessionId]: { ...c, assistantPicker: null } }
    })
  }, [])
```

- [ ] **Step 4: Import the helpers used by the actions**

At the top of `workspaceStore.ts`, in the existing `'../copyAssistant'` import (search for `from '../copyAssistant'`), add the new helpers:

```ts
import {
  extractLastAssistantText,
  extractAssistantByUuid,
  assistantUuidsWithText,
} from '../copyAssistant'
```

If the existing import is a side-effect-only line or a single-default import, replace with the named-imports form above.

- [ ] **Step 5: Expose the actions in the workspace return value**

Find the workspace return block (search for `toggleTailMode,`). Add the four picker actions next to it:

```ts
    toggleTailMode,
    pickerEnter,
    pickerMove,
    pickerConfirm,
    pickerCancel,
  }
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts
git commit -m "feat(workspace): assistantPicker runtime state + enter/move/confirm/cancel actions"
```

---

## Task 3: Command registry entry

**Files:**
- Create: `src/renderer/src/features/copy-assistant/commands/copyAssistantCommands.ts`
- Modify: `src/renderer/src/commands/registry.ts`

- [ ] **Step 1: Create the command file**

Create `src/renderer/src/features/copy-assistant/commands/copyAssistantCommands.ts`:

```ts
import type { CommandDef } from '../../../commands/types'

// "Copy Assistant Message" — opens the picker on the focused pane.
// All navigation (Up/Down/Enter/Esc) is handled by useKeybinds when
// the runtime's assistantPicker is non-null. The command itself only
// toggles entry — it does NOT copy directly. Distinct from
// "Copy Last Response" (paneCommands.ts), which copies the most-
// recent assistant message immediately with no picker.
export const copyAssistantCommands: CommandDef[] = [
  {
    id: 'copy-assistant-message',
    title: 'Copy Assistant Message…',
    keywords: ['copy', 'assistant', 'message', 'response', 'pick'],
    when: ({ workspace }) => workspace.activeTab !== null,
    run: ({ workspace }) => {
      const tab = workspace.activeTab
      if (!tab) return
      workspace.pickerEnter(tab.focusedSessionId)
    },
  },
]
```

- [ ] **Step 2: Register in the central registry**

Open `src/renderer/src/commands/registry.ts`. Add the import alongside the others (alphabetical with the rest) and include in the `commandDefs` spread:

```ts
import { copyAssistantCommands } from '../features/copy-assistant/commands/copyAssistantCommands'
```

```ts
const commandDefs: CommandDef[] = [
  ...tabCommands,
  ...paneCommands,
  ...layoutCommands,
  ...sessionCommands,
  ...spotlightCommands,
  ...readerCommands,
  ...tileTabsCommands,
  ...settingsCommands,
  ...copyAssistantCommands,
]
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev`. Open the command palette (⌘⇧P). Type "copy ass". The new "Copy Assistant Message…" command appears. Selecting it should toggle the runtime field but not yet show any visual highlight (Feed wiring is the next task).

To confirm the action is firing without UI: open dev tools and run `Object.values(workspace_runtimes_or_however_you_inspect).map(r => r.assistantPicker)` — there's no exposed handle so this is not an easy check from devtools; if you can't find one, skip and trust Task 4 to surface it.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/copy-assistant/commands/copyAssistantCommands.ts src/renderer/src/commands/registry.ts
git commit -m "feat(copy-assistant): register Copy Assistant Message command"
```

---

## Task 4: Feed renders the picker outline

**Files:**
- Modify: `src/renderer/src/feed/Feed.tsx`
- Modify: `src/renderer/src/tiles/TileLeaf.tsx`

- [ ] **Step 1: Add the prop to Feed**

In `src/renderer/src/feed/Feed.tsx`, find the `type Props = {` block (around line 305-325). Add the picker prop after `tailMode`:

```ts
  tailMode?: boolean
  /**
   * UUID of the assistant entry currently highlighted by the
   * "Copy Assistant Message" picker. Null when the picker is not
   * active. Drives a 2px accent outline on the matching row and
   * auto-scrolls into view when the value changes.
   */
  pickerSelectedUuid?: string | null
  showSystemEvents: boolean
```

- [ ] **Step 2: Destructure the prop in FeedImpl**

Find the `function FeedImpl({` destructure block (around line 415). Add `pickerSelectedUuid` next to `tailMode`:

```ts
  tailMode = false,
  pickerSelectedUuid = null,
  showSystemEvents,
```

- [ ] **Step 3: Auto-scroll the selected entry into view when it changes**

After the existing auto-scroll-on-content-change effect (search for `}, [entries.length, streamingScreen, tailMode])`), add a new effect:

```ts
  // When the picker selection changes, scroll the highlighted entry
  // into view. Uses scrollIntoView({block: 'nearest'}) so we don't
  // jump for entries already visible — only when the selection
  // moves off-screen.
  useEffect(() => {
    if (!pickerSelectedUuid) return
    const root = scrollerRef.current
    if (!root) return
    const target = root.querySelector(
      `[data-entry-uuid="${pickerSelectedUuid}"]`,
    ) as HTMLElement | null
    if (target) {
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [pickerSelectedUuid])
```

- [ ] **Step 4: Tag each entry row with its uuid + apply the outline class**

Find the `visible.map((e, i) => {` block. Replace the current `<LazyEntry>` invocation with a wrapper that carries the uuid + selection state:

```ts
          {visible.map((e, i) => {
            const key = (e as Entry).uuid ?? `i${i}`
            const eager = i >= visible.length - EAGER_TAIL
            const selected =
              pickerSelectedUuid != null &&
              (e as Entry).uuid === pickerSelectedUuid
            return (
              <div
                key={key}
                data-entry-uuid={(e as Entry).uuid ?? undefined}
                className={
                  selected
                    ? 'outline outline-2 outline-accent outline-offset-2 transition-[outline-color] duration-150'
                    : undefined
                }
              >
                <LazyEntry eager={eager} scrollerRef={scrollerRef}>
                  <EntryRow entry={e} />
                </LazyEntry>
              </div>
            )
          })}
```

(Removed the `key` from `<LazyEntry>` because React's reconciliation now keys on the wrapper `<div>`. LazyEntry no longer needs a key prop.)

- [ ] **Step 5: Pipe the prop from TileLeaf**

In `src/renderer/src/tiles/TileLeaf.tsx`, find the `<Feed` invocation (search for `streamingBaseline={runtime.streamingBaseline}`). Add the new prop next to `tailMode`:

```ts
          tailMode={runtime.tailMode}
          pickerSelectedUuid={runtime.assistantPicker?.selectedUuid ?? null}
          showSystemEvents={false}
```

- [ ] **Step 6: Type-check + build**

Run: `npx tsc --noEmit -p . && npm run build 2>&1 | grep -E "Could not|✓ built|x Build" | tail -5`
Expected: no type errors; build prints `✓ built` lines, no `x Build` or `Could not`.

- [ ] **Step 7: Manual smoke test**

Run: `npm run dev`. Open a Claude pane that has at least 2 assistant messages (chat with the agent if needed). Open the command palette and run "Copy Assistant Message…". You should see a 2px accent outline around the most recent assistant entry. The keybinds aren't wired yet (next task), so Up/Down won't work. Run the command again to dismiss.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/feed/Feed.tsx src/renderer/src/tiles/TileLeaf.tsx
git commit -m "feat(feed): outline picker-selected entry; auto-scroll into view on selection change"
```

---

## Task 5: Keybinds (Up/Down/Enter/Esc)

**Files:**
- Modify: `src/renderer/src/tiles/useKeybinds.ts`

- [ ] **Step 1: Add the picker-active block at the top of the keydown handler**

In `src/renderer/src/tiles/useKeybinds.ts`, find the existing Esc-then-Spotlight-then-Reader block (around line 76-95). Add the picker block IMMEDIATELY BEFORE the Spotlight Esc handler so it intercepts arrow keys before they can be routed elsewhere:

```ts
      // --- Copy Assistant picker (Up/Down/Enter/Esc) ---
      //
      // Active when the focused pane's runtime has assistantPicker set.
      // We capture all four keys here so the focused composer doesn't
      // receive them. The picker is dismissed on Enter (after copy)
      // and Esc (without copy); arrow keys move the selection.
      //
      // Lives BEFORE the Spotlight Esc handler so picker-Esc wins
      // when both modes happen to be active (shouldn't happen in
      // practice — picker is feed-only — but the ordering keeps the
      // intent local to this block).
      const focusedTab = workspace.activeTab
      const focusedSessionId = focusedTab?.focusedSessionId
      const picker = focusedSessionId
        ? workspace.runtimes[focusedSessionId]?.assistantPicker
        : null
      if (picker && focusedSessionId) {
        if (k === 'ArrowUp') {
          e.preventDefault()
          workspace.pickerMove(focusedSessionId, -1)
          return
        }
        if (k === 'ArrowDown') {
          e.preventDefault()
          workspace.pickerMove(focusedSessionId, +1)
          return
        }
        if (k === 'Enter') {
          e.preventDefault()
          void workspace.pickerConfirm(focusedSessionId)
          return
        }
        if (k === 'Escape') {
          e.preventDefault()
          workspace.pickerCancel(focusedSessionId)
          return
        }
        // Any other key falls through — typing into the composer
        // doesn't cancel the picker. If we want "any keystroke
        // cancels", that's a one-line follow-up; leaving it
        // permissive for now so accidental keypresses don't lose
        // the user's place.
      }

      if (k === 'Escape' && workspace.spotlight) {
```

- [ ] **Step 2: Confirm `workspace.runtimes` is exposed**

Search for `runtimes,` in the workspace return block in `workspaceStore.ts`:

```bash
grep -n "    runtimes," src/renderer/src/tiles/workspaceStore.ts
```

Expected: 1 line, around line 2480-2510 (in the return). If missing, add it next to the other returned slots — but it should already be there.

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit -p . && npm run build 2>&1 | grep -E "Could not|✓ built|x Build" | tail -5`
Expected: type-clean, build green.

- [ ] **Step 4: Full end-to-end manual smoke test**

Run: `npm run dev`.

1. Open a Claude pane. Type a few messages so you have ≥3 assistant turns. Or open an existing session that already has them.
2. Open the command palette (⌘⇧P) and run "Copy Assistant Message…".
3. The most recent assistant message gets the accent outline.
4. Press Up — the outline jumps to the previous assistant message; if it's off-screen, the feed scrolls smoothly to bring it into view.
5. Press Down — outline moves back toward newer messages.
6. Up at the very-top assistant entry: nothing happens (clamps).
7. Press Enter — outline disappears, "Copied assistant message" toast shows in the pane footer, clipboard contains the text. Paste into a scratch buffer to confirm.
8. Re-enter the picker, then press Esc. Outline disappears, no toast, clipboard unchanged.

If any step fails, capture which and which key was pressed, then debug from there before committing.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/tiles/useKeybinds.ts
git commit -m "feat(copy-assistant): arrow/Enter/Esc keybinds drive the picker on the focused pane"
```

---

## Task 6: Auto-cancel the picker when the selected entry disappears

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts`

- [ ] **Step 1: Add an effect that watches entries and cancels the picker if the selectedUuid is no longer present**

Open `src/renderer/src/tiles/workspaceStore.ts`. Find the existing `useEffect` block that handles ReaderMode invalidation (search for `if (!readerMode) return`). Add a new effect immediately after it:

```ts
  // Picker invalidation. If the selected uuid is no longer in any
  // session's entries (entries cleared by a session swap, conversation
  // wipe, etc.), cancel the picker. Without this the outline would
  // disappear (because the matching DOM node is gone) but the picker
  // state would linger and capture keystrokes.
  useEffect(() => {
    for (const [sessionId, runtime] of Object.entries(runtimes)) {
      if (!runtime.assistantPicker) continue
      const uuids = assistantUuidsWithText(runtime.entries)
      if (!uuids.includes(runtime.assistantPicker.selectedUuid)) {
        // Use the existing pickerCancel — it's already a stable
        // useCallback so it won't churn this effect on each render.
        pickerCancel(sessionId)
      }
    }
  }, [runtimes, pickerCancel])
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 3: Manual smoke test (low effort)**

Run: `npm run dev`. Open a Claude pane with assistant messages, enter the picker, then `/clear` the conversation in the pane. The outline should vanish and Up/Down should stop being captured (try moving — nothing happens, the composer takes the keystrokes again).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts
git commit -m "fix(copy-assistant): cancel picker when the selected entry is no longer present"
```

---

## Task 7: Push and confirm

**Files:** none.

- [ ] **Step 1: Push all six commits**

Run: `git push 2>&1 | tail -3`
Expected: a single `→ main` line, no errors.

- [ ] **Step 2: Verify the chain is intact**

Run: `git log --oneline -8`
Expected: the six new commits sit on top of the current HEAD, in order:

```
fix(copy-assistant): cancel picker when the selected entry is no longer present
feat(copy-assistant): arrow/Enter/Esc keybinds drive the picker on the focused pane
feat(feed): outline picker-selected entry; auto-scroll into view on selection change
feat(copy-assistant): register Copy Assistant Message command
feat(workspace): assistantPicker runtime state + enter/move/confirm/cancel actions
feat(copy-assistant): pure helpers — extract assistant text by uuid; list assistant uuids with text
```

---

## Self-Review

**Spec coverage**

| Spec point | Task |
| --- | --- |
| Run command from a pane → enters picker mode | Task 3 (command), Task 2 (state) |
| Latest assistant entry initially highlighted | Task 2 Step 3 (`pickerEnter` picks last uuid) |
| Up/Down navigates prev/next | Task 2 (`pickerMove`), Task 5 (keybinds) |
| Enter copies + dismisses + toast | Task 2 (`pickerConfirm`), Task 5 (keybind) |
| Esc cancels without copying | Task 2 (`pickerCancel`), Task 5 (keybind) |
| Visible outline | Task 4 Step 4 (`outline outline-2 outline-accent`) |
| Auto-scroll into view | Task 4 Step 3 (effect on `pickerSelectedUuid`) |

**Type consistency**

- `assistantPicker: { selectedUuid: string } | null` — same shape used in `pickerEnter`/`pickerMove`/`pickerConfirm`/`pickerCancel`/Feed prop derivation.
- `pickerMove(sessionId, direction: -1 | 1)` — direction is fixed two-value union; keybinds pass `-1` and `+1` literally; matches.
- `pickerSelectedUuid?: string | null` on Feed — TileLeaf passes `runtime.assistantPicker?.selectedUuid ?? null`, type matches.
- `extractAssistantByUuid(entries, uuid): string | null` — used by `pickerConfirm` with `current.assistantPicker.selectedUuid` (string), matches.
- `assistantUuidsWithText(entries): string[]` — used by `pickerEnter`, `pickerMove`, and the invalidation effect.

**Placeholder scan**

- No "TBD"/"implement later".
- Task 3 Step 4 says "if you can't find one, skip and trust Task 4 to surface it" — that's a real fallback instruction, not a placeholder.
- All code blocks contain real code; no "fill in the rest" lines.

**Risks**

1. **`workspace.runtimes` exposure** — Task 5 assumes `runtimes` is in the workspace return value. If it isn't (some hooks expose only `getRuntime`), Task 5 Step 2 catches it; the fix is a one-line addition to the return block.
2. **scrollIntoView smooth on a hot scroller** — if the feed has thousands of entries and the user spams Up, smooth animation could lag. If it does, swap `behavior: 'smooth'` to `behavior: 'auto'` (instant) — one-line change.
3. **Composer steals Enter** — useKeybinds uses `capture: true` so it runs before the focused input. Confirmed by reading the existing handler comment ("capture the key BEFORE the focused input element sees it"). Picker block is inside the same handler so inherits the capture.

---

## Notes for follow-up (not in this plan)

- **Default keybind** (e.g., `⌘⇧Y` for "yank") — one-line addition in useKeybinds.
- **Reader Mode integration** — let Up/Down inside Reader walk the same picker, so Reader becomes the read+yank surface. Probably worth a separate plan.
- **Multi-select / range copy** — substantially harder (text-range mapping over rendered markdown), would need its own plan.
- **"Copy as quoted markdown"** variant that prefixes each line with `> ` — trivial follow-up command sharing the same picker.
