# Bootstrap Replay Perf Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make app restart / pane resume feel instant — eliminate the 10-second "scrolling through the whole conversation" cascade when a Claude or Codex session rehydrates with a transcript.

**Architecture:** The cascade has four multiplicative causes: per-entry IPC sends, per-entry React re-renders, per-entry `[...arr, x]` spreads, and per-entry auto-scroll pins. We introduce a **bootstrap phase** — a short window after spawn during which main coalesces jsonl-entry events into bulk IPC messages, the renderer folds them in a single `setRuntimes`, auto-scroll and lazy-mount are suspended, and a single pin-to-bottom runs when the phase ends. All live-streaming semantics (single-entry appends, sticky-bottom autoscroll) are preserved after the phase ends.

**Tech Stack:** Electron IPC, React 18, Zustand-less custom store (`useState` + refs in `workspaceStore.ts`), Node EventEmitter on main.

---

## File Structure

**Modify:**
- `src/main/index.ts` — add a per-session jsonl-entry coalescer that flushes on a microtask/setImmediate tick as `session:jsonl-entries` (plural). Keep the singular channel for late-arriving live events so nothing else has to change.
- `src/preload/index.ts` — expose `onSessionJsonlEntries(cb)` and the matching `SessionJsonlEntriesEvent` type.
- `src/renderer/src/tiles/workspaceState.ts` — extend `SessionRuntime` with `bootstrapping: boolean` and cached incremental `toolUseIndex` / `toolResultIndex` maps.
- `src/renderer/src/tiles/workspaceStore.ts` — subscribe to bulk channel, fold entries in one `setRuntimes`, mark `bootstrapping` true on session start, clear it after a quiet window, update tool indices incrementally.
- `src/renderer/src/feed/Feed.tsx` — skip auto-scroll and IntersectionObserver-driven lazy mount while `bootstrapping` is true; pin once on transition to false; consume tool indices from runtime instead of rebuilding via `useMemo`.
- `src/shared/ui/LazyEntry.tsx` — accept a `suspended` prop; when true, stay a placeholder (no observer attached).

**No new files** — the fix is structural glue that lives next to the existing IPC/store/feed code.

---

### Task 1: Coalesce jsonl-entry IPC sends in main

**Files:**
- Modify: `src/main/index.ts:194-213` (the `wireManagerIPC` function)

**Why:** Per-entry `webContents.send` is the first multiplier — 200 entries per session × N sessions on restart. Coalescing with `setImmediate` (runs after the current I/O tick, which is when a bootstrapTail loop finishes) gives us one flush per burst without introducing perceptible latency for live streaming.

- [ ] **Step 1: Add a coalescer above `wireManagerIPC`**

In `src/main/index.ts`, immediately before `function wireManagerIPC()`:

```ts
// Per-session jsonl-entry coalescer.
//
// WHY: on a resumed Claude/Codex session, the headless `bootstrapTail`
// parses the last ~200 lines from the JSONL file synchronously and
// emits one `jsonl-entry` event per line. Forwarding each as its own
// IPC `webContents.send` produced ~200 round-trips per pane × N panes
// on restart — which on the renderer side became 200N React renders,
// 200N O(N) spreads, and 200N auto-scroll pins. That's the "feels
// like I'm being scrolled through the whole conversation" bug.
//
// Coalescing: we buffer entries per sessionId, schedule ONE
// setImmediate flush, and deliver the whole burst as a single
// `session:jsonl-entries` payload. setImmediate (not Promise.resolve
// or process.nextTick) runs after the current I/O tick finishes, so
// the whole bootstrapTail loop drains before we schedule a send. Live
// mid-conversation entries land one per tick and are flushed
// immediately after — no added latency for the streaming path.
//
// Singular `session:jsonl-entry` is intentionally kept alive: any
// non-bulk consumer (tests, future single-entry subscribers) can
// still listen, and keeping both channels means this change is
// strictly additive from the renderer's perspective. The renderer
// subscribes to BOTH and picks whichever it prefers.
type PendingBuffer = {
  entries: Array<{ entry: import('claude-code-headless').JsonlEntry; file: string }>
  flushScheduled: boolean
}
const jsonlPending = new Map<string, PendingBuffer>()

function flushJsonlFor(sessionId: string): void {
  const pending = jsonlPending.get(sessionId)
  if (!pending || pending.entries.length === 0) return
  const payload = {
    sessionId,
    entries: pending.entries,
  }
  pending.entries = []
  pending.flushScheduled = false
  send('session:jsonl-entries', payload)
}

function enqueueJsonl(
  sessionId: string,
  entry: import('claude-code-headless').JsonlEntry,
  file: string,
): void {
  let pending = jsonlPending.get(sessionId)
  if (!pending) {
    pending = { entries: [], flushScheduled: false }
    jsonlPending.set(sessionId, pending)
  }
  pending.entries.push({ entry, file })
  if (!pending.flushScheduled) {
    pending.flushScheduled = true
    setImmediate(() => flushJsonlFor(sessionId))
  }
}
```

- [ ] **Step 2: Replace the singular forwarder with the coalescer**

In `wireManagerIPC`, change line 197 from:

```ts
  manager.on('jsonl-entry', payload => send('session:jsonl-entry', payload))
```

to:

```ts
  // Dual-emit: bulk channel for the common case, singular channel
  // kept for any late-arriving consumer that only wants one event at
  // a time. Bulk consumer can ignore the singular channel entirely
  // (see preload subscription wiring).
  manager.on('jsonl-entry', payload => {
    enqueueJsonl(payload.sessionId, payload.entry, payload.file)
    send('session:jsonl-entry', payload)
  })
```

- [ ] **Step 3: Purge pending buffer on session exit**

Also in `wireManagerIPC`, locate the `manager.on('exit', …)` line (around line 212) and replace it with:

```ts
  manager.on('exit', payload => {
    // Final flush — any entries still buffered from the last
    // bootstrapTail tick must land before exit so the renderer sees a
    // consistent final entries list.
    flushJsonlFor(payload.sessionId)
    jsonlPending.delete(payload.sessionId)
    send('session:exit', payload)
  })
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "$(cat <<'EOF'
perf(ipc): coalesce jsonl-entry forwarding in main

A resumed Claude/Codex session fires ~200 jsonl-entry events
synchronously during bootstrapTail. Forwarding each as its own
webContents.send produced 200 IPC round-trips per pane, each
causing an independent React render on the renderer side. Buffer
per sessionId and flush on setImmediate — live entries still land
one tick later with no perceptible latency, and the bootstrap
burst becomes a single delivery.

The singular session:jsonl-entry channel is kept alive for any
consumer that still wants single-entry events; the renderer
subscribes to the bulk channel in the next commit.
EOF
)"
```

---

### Task 2: Preload type + subscription for the bulk channel

**Files:**
- Modify: `src/preload/index.ts:52-57` and the exposed API block lower in the file.

**Why:** Renderer cannot consume a channel it doesn't see. Add the type alongside the existing singular one so renderer code can subscribe without casts.

- [ ] **Step 1: Add the bulk event type**

Replace the existing type block at `src/preload/index.ts:52-57`:

```ts
export type SessionJsonlEntryEvent = {
  sessionId: string
  entry: JsonlEntry
  file: string
}
export type SessionJsonlErrorEvent = { sessionId: string; message: string }
```

with:

```ts
export type SessionJsonlEntryEvent = {
  sessionId: string
  entry: JsonlEntry
  file: string
}
// Bulk variant used by main during bootstrap bursts. Payload is an
// array of {entry, file} tuples for a single session — the renderer
// folds them in one setState instead of paying one render per entry.
// See main/index.ts jsonl coalescer for the WHY.
export type SessionJsonlEntriesEvent = {
  sessionId: string
  entries: Array<{ entry: JsonlEntry; file: string }>
}
export type SessionJsonlErrorEvent = { sessionId: string; message: string }
```

- [ ] **Step 2: Add the subscription method**

Locate the `onSessionJsonlEntry` wiring at `src/preload/index.ts:237-238`:

```ts
  onSessionJsonlEntry: (cb: (e: SessionJsonlEntryEvent) => void): Unsub =>
    subscribe('session:jsonl-entry', cb),
```

Add the bulk subscription right below it:

```ts
  onSessionJsonlEntry: (cb: (e: SessionJsonlEntryEvent) => void): Unsub =>
    subscribe('session:jsonl-entry', cb),
  // Bulk: the whole burst from one bootstrap flush, or a single live
  // entry wrapped in a 1-element array. Renderer can treat them
  // identically. See main/index.ts for why the bulk channel exists.
  onSessionJsonlEntries: (cb: (e: SessionJsonlEntriesEvent) => void): Unsub =>
    subscribe('session:jsonl-entries', cb),
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts
git commit -m "$(cat <<'EOF'
feat(preload): expose bulk session:jsonl-entries channel

Adds SessionJsonlEntriesEvent and onSessionJsonlEntries so the
renderer can fold a whole bootstrap burst in one setState. Paired
with the coalescer in main — renderer consumption comes next.
EOF
)"
```

---

### Task 3: Runtime fields for bootstrap phase + incremental tool indices

**Files:**
- Modify: `src/renderer/src/tiles/workspaceState.ts:202-229` (emptyRuntime + SessionRuntime type).

**Why:** The renderer needs three new pieces of state on the runtime:

1. `bootstrapping: boolean` — set to true when a bulk bootstrap burst starts, false when it ends. Feed and LazyEntry read this to suspend auto-scroll and lazy-mount cascades.
2. `toolUseIndex: Map<string, ToolUseBlock>` / `toolResultIndex: Map<string, ToolResultBlock>` — maintained incrementally at entry-ingest time instead of rebuilt via `useMemo` on every render. Saves O(N²) on bootstrap and O(N) on every live append after that.

- [ ] **Step 1: Read the current SessionRuntime shape**

Open `src/renderer/src/tiles/workspaceState.ts` and locate the `SessionRuntime` type (just above `emptyRuntime`). Note the existing field names so your additions slot in cleanly.

- [ ] **Step 2: Add the imports for the tool block types**

At the top of `src/renderer/src/tiles/workspaceState.ts`, add or extend the transcript import to include the two tool block types:

```ts
import type {
  ToolUseBlock,
  ToolResultBlock,
} from '../../../shared/types/transcript'
```

If there is already a `from '../../../shared/types/transcript'` import block, add `ToolUseBlock` and `ToolResultBlock` to its named imports rather than creating a second statement.

- [ ] **Step 3: Extend SessionRuntime**

Locate the SessionRuntime type and append these fields (place them after `loadingOlderHistory`, before `tailMode`):

```ts
  // True while a bulk bootstrap burst is being delivered — set when
  // the first batched jsonl-entries event lands, cleared after a
  // short quiet window. Feed suspends auto-scroll and lazy-mount
  // cascades while this is true; a single pin-to-bottom runs on the
  // transition back to false. WHY a boolean: a one-shot phase is
  // simpler than a counter because we don't need to track overlapping
  // bursts — setImmediate on main guarantees one flush per tick.
  bootstrapping: boolean
  // Incremental tool_use/tool_result indices, keyed by tool_use_id.
  // Maintained at entry-ingest time so Feed doesn't rebuild them via
  // useMemo([entries]) on every append — that used to be O(N²) during
  // bootstrap (200 entries × O(N) rebuild per render × 200 renders).
  // Maps are mutated in place inside setRuntimes + the runtime object
  // reference changes each append, which is fine because Feed reads
  // the maps by reference through context, not by shallow compare.
  toolUseIndex: Map<string, ToolUseBlock>
  toolResultIndex: Map<string, ToolResultBlock>
```

- [ ] **Step 4: Initialize in emptyRuntime**

Inside `emptyRuntime()` add the three new fields alongside the existing defaults:

```ts
    bootstrapping: false,
    toolUseIndex: new Map(),
    toolResultIndex: new Map(),
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. (Consumers that read `runtime.toolUseIndex` haven't been added yet; existing code doesn't reference it.)

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/tiles/workspaceState.ts
git commit -m "$(cat <<'EOF'
feat(workspace-state): add bootstrapping flag + incremental tool indices

Three new fields on SessionRuntime:
- bootstrapping: true during a bulk bootstrap burst; Feed will
  suspend auto-scroll and lazy-mount while it's true.
- toolUseIndex / toolResultIndex: maps built incrementally at entry
  ingest so Feed doesn't rebuild them via useMemo per render.

No consumers yet — the store hook-up and Feed consumption land in
the next two commits.
EOF
)"
```

---

### Task 4: Renderer bulk ingest + incremental indices + bootstrap phase

**Files:**
- Modify: `src/renderer/src/tiles/workspaceStore.ts` — subscribe to `onSessionJsonlEntries`, fold the whole burst in one `setRuntimes`, mark/clear `bootstrapping`, grow the tool indices incrementally.

**Why:** This is where the multiplier collapses. One `setRuntimes` call per burst, one index update per entry (not per render), and the `bootstrapping` signal propagates to Feed for the scroll/mount suppression.

- [ ] **Step 1: Add imports at the top of workspaceStore.ts**

Ensure these are in the imports from `'../../../shared/types/transcript'` (add if missing):

```ts
import type { ToolResultBlock, ToolUseBlock } from '../../../shared/types/transcript'
```

- [ ] **Step 2: Add a helper that folds a single entry into a draft runtime**

Above the existing single-entry handler (search for `onSessionJsonlEntry`), add:

```ts
// Mutates `indices` and returns a new entry list. Pulls the tool_use
// / tool_result indexing inline so bulk bootstrap ingests don't have
// to rebuild the maps at render time. Kept separate from React state
// so we can reuse it for both the bulk and singular paths.
//
// WHY mutate maps: the Map reference on the runtime object is
// unchanged, so React.memo of children that read the maps by
// reference continues to work. Feed will read via context and treat
// the map as a live lookup, not a prop to diff — see Task 5.
function indexEntryIntoMaps(
  entry: Entry,
  toolUseIndex: Map<string, ToolUseBlock>,
  toolResultIndex: Map<string, ToolResultBlock>,
): void {
  if (!isConversationEntry(entry)) return
  const content = entry.message.content
  if (!Array.isArray(content)) return
  for (const b of content) {
    if (b.type === 'tool_use') {
      const tu = b as ToolUseBlock
      toolUseIndex.set(tu.id, tu)
    } else if (b.type === 'tool_result') {
      const tr = b as ToolResultBlock
      toolResultIndex.set(tr.tool_use_id, tr)
    }
  }
}
```

- [ ] **Step 3: Add the bulk ingest subscription**

Inside the IPC-subscription `useEffect` (search for `offEntry = window.api.onSessionJsonlEntry`), add a second subscription immediately below the existing `offEntry` line:

```ts
    // Bulk path — one setRuntimes per burst, incremental indices,
    // bootstrapping flag toggled on first burst and cleared after a
    // quiet window.
    //
    // WHY we keep the singular handler alive: providers may choose to
    // emit a late non-bootstrapped entry directly (tests, non-resumed
    // sessions where no coalesce happened). The singular handler
    // de-dupes via seenUuidsRef, so adding an entry twice is a no-op.
    const offEntries = window.api.onSessionJsonlEntries(({ sessionId, entries }) => {
      if (!entries || entries.length === 0) return

      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const seen = (seenUuidsRef.current[sessionId] ??= new Set())
        const appended: Entry[] = []
        let oldestMarker: string | null = current.historyOldestMarker
        let pendingCompaction = current.pendingCompaction

        // Reuse existing index maps so referential consumers
        // (contexts in Feed) see updates in place. The runtime object
        // itself gets a fresh top-level reference below so React
        // re-renders; the map references are stable.
        const toolUseIndex = current.toolUseIndex
        const toolResultIndex = current.toolResultIndex

        for (const { entry: raw } of entries) {
          // Reuse the existing codex-vs-claude discrimination inline.
          // We are intentionally duplicating a compact version of the
          // singular handler's logic rather than calling into it —
          // that handler calls setState/setRuntimes per entry, which
          // is exactly what this path must NOT do.
          if (isCodexRolloutEntry(raw)) {
            const mapped = mapCodexRolloutToFeedEntries(raw)
            const marker = mapped.length > 0 ? codexHistoryMarker(raw) : null
            if (marker && !oldestMarker) oldestMarker = marker
            for (const e of mapped) {
              const u = (e as { uuid?: string }).uuid
              if (u) {
                if (seen.has(u)) continue
                seen.add(u)
              }
              appended.push(e)
              indexEntryIntoMaps(e, toolUseIndex, toolResultIndex)
            }
            continue
          }

          const feedEntry =
            extractEmbeddedClaudeProgressEntry(raw as Record<string, unknown>) ??
            (raw as Entry)
          const marker = claudeHistoryMarker(raw as Record<string, unknown>)
          if (marker && !oldestMarker) oldestMarker = marker
          const uuid = (feedEntry as { uuid?: string }).uuid
          if (uuid) {
            if (seen.has(uuid)) continue
            seen.add(uuid)
          }
          if (
            !isConversationEntry(feedEntry) &&
            !isCompactBoundaryEntry(feedEntry) &&
            !isCompactSummaryEntry(feedEntry)
          ) {
            continue
          }
          if (isCompactSummaryEntry(feedEntry)) pendingCompaction = null
          appended.push(feedEntry)
          indexEntryIntoMaps(feedEntry, toolUseIndex, toolResultIndex)
        }

        if (appended.length === 0) return prev

        return {
          ...prev,
          [sessionId]: {
            ...current,
            entries: [...current.entries, ...appended],
            historyOldestMarker: oldestMarker,
            bootstrapping: true,
            pendingCompaction,
            toolUseIndex,
            toolResultIndex,
          },
        }
      })

      // Schedule the bootstrap flip. Each new burst resets the timer
      // — the phase ends after ~150ms of quiet (long enough to cover
      // a laggy resume replay; short enough that the user doesn't
      // notice a deferred scroll pin). Stored per sessionId on a ref
      // so we clear it on unmount / session kill.
      const existing = bootstrapTimersRef.current.get(sessionId)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        bootstrapTimersRef.current.delete(sessionId)
        setRuntimes(prev => {
          const current = prev[sessionId]
          if (!current || !current.bootstrapping) return prev
          return {
            ...prev,
            [sessionId]: { ...current, bootstrapping: false },
          }
        })
      }, 150)
      bootstrapTimersRef.current.set(sessionId, timer)
    })
```

- [ ] **Step 4: Declare the timer ref at the top of the hook**

Near the other refs (`seenUuidsRef`, `latestScreenRef`, etc., search for `seenUuidsRef = useRef`), add:

```ts
  // Per-session setTimeout ids used to debounce the bootstrapping
  // flag back to false. Keyed by sessionId; cleared in the exit /
  // killSession cleanup paths. Ref (not state) because the timer
  // handle is irrelevant to rendering and we just need it alive
  // across the hook's tick.
  const bootstrapTimersRef = useRef<Map<SessionId, ReturnType<typeof setTimeout>>>(new Map())
```

- [ ] **Step 5: Add the cleanup pairing**

In the same IPC-subscription `useEffect`, extend the return cleanup function so it also tears down the new subscription and clears all timers:

Find the cleanup block (search for `return () =>` inside that effect) and extend it. For example if it currently reads:

```ts
    return () => {
      offEntry()
      /* other existing offs */
    }
```

make it:

```ts
    return () => {
      offEntry()
      offEntries()
      /* other existing offs */
      for (const t of bootstrapTimersRef.current.values()) clearTimeout(t)
      bootstrapTimersRef.current.clear()
    }
```

- [ ] **Step 6: Clear the bootstrap timer in killSession**

Inside the `killSession` `useCallback` (currently around line 1959), add immediately after `delete latestScreenRef.current[sessionId]`:

```ts
    const timer = bootstrapTimersRef.current.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      bootstrapTimersRef.current.delete(sessionId)
    }
```

- [ ] **Step 7: Update the singular handler to also grow tool indices**

Inside the existing `onSessionJsonlEntry` handler (search for `setRuntimes(prev => {` inside `offEntry`), locate the point where `nextEntries = [...current.entries, feedEntry]` is computed. Immediately before the `return {` that produces the new runtime, add:

```ts
        // Grow tool indices incrementally. Same rationale as the
        // bulk path — Feed no longer rebuilds them in useMemo.
        indexEntryIntoMaps(feedEntry, current.toolUseIndex, current.toolResultIndex)
```

Repeat the same `indexEntryIntoMaps(...)` call at the end of the Codex branch, just before its `return { ...prev, [sessionId]: { ... } }`, passing each mapped entry through the maps.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/tiles/workspaceStore.ts
git commit -m "$(cat <<'EOF'
perf(workspace): fold bootstrap bursts in one setRuntimes

Subscribe to session:jsonl-entries; fold a whole burst in one
setState, grow tool indices incrementally at ingest, and set
runtime.bootstrapping=true for the duration. A 150ms quiet-window
debounce clears the flag back to false; Feed uses it to suspend
auto-scroll and lazy-mount cascades in the next commit.

The singular handler is updated to also index incrementally so
live streaming and the bulk path share one mapping layer.
EOF
)"
```

---

### Task 5: Suspend auto-scroll + lazy-mount during bootstrap

**Files:**
- Modify: `src/shared/ui/LazyEntry.tsx` — accept `suspended`, stay a placeholder while true.
- Modify: `src/renderer/src/feed/Feed.tsx` — skip auto-scroll while `bootstrapping` is true; pin exactly once on the transition to false; consume tool indices from runtime instead of `useMemo`.

**Why:** Even with bulk ingest, a single big setState still renders once. If during that render we pin-to-bottom and mount every placeholder within 200px of the viewport, the user still perceives a layout cascade. Suspending both until after the burst means one render, one pin, one observer pass.

- [ ] **Step 1: Extend LazyEntry with a suspended prop**

Replace the LazyEntry component in `src/shared/ui/LazyEntry.tsx` with:

```ts
// LazyEntry — IntersectionObserver-based deferred mounting for feed entries.
//
// Entries above the viewport start as a thin placeholder. When the user
// scrolls up to them, the real content mounts. Once mounted, stays
// mounted permanently — React.memo's cached render tree survives,
// avoiding re-parse costs that virtualization (unmount/remount) would cause.
//
// `suspended` is set by Feed while the owning session is in a bootstrap
// burst. The rationale: during bootstrap we are about to land ~200
// entries at once, and every placeholder within rootMargin of the
// viewport would mount in the SAME render — which is the lazy-mount
// cascade that makes restart feel like you're being scrolled through
// the whole transcript. While suspended, the observer isn't attached
// and the placeholder stays a 48px stub. When the parent flips the
// prop back to false, the observer attaches and the normal flow
// resumes.

import { memo, useEffect, useRef, useState, type ReactNode } from 'react'

export const EAGER_TAIL = 30

export const LazyEntry = memo(function LazyEntry({
  eager,
  suspended = false,
  scrollerRef,
  children,
}: {
  eager: boolean
  suspended?: boolean
  scrollerRef: React.RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(eager)
  const placeholderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (eager && !mounted) setMounted(true)
  }, [eager, mounted])

  useEffect(() => {
    if (mounted) return
    if (suspended) return
    const el = placeholderRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMounted(true)
          observer.disconnect()
        }
      },
      { root: scrollerRef.current, rootMargin: '200px 0px 200px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [mounted, suspended, scrollerRef])

  if (!mounted) {
    return <div ref={placeholderRef} className="min-h-[48px]" />
  }

  return <>{children}</>
})
```

- [ ] **Step 2: Accept a bootstrapping prop on Feed**

In `src/renderer/src/feed/Feed.tsx` locate the `Props` type (around line 308) and add:

```ts
  /** True while the owning session is replaying a bulk bootstrap
   *  burst. Feed uses it to suspend auto-scroll pinning and the
   *  IntersectionObserver-driven lazy mount, avoiding the layout
   *  cascade that otherwise makes resume feel like "scrolling
   *  through the whole conversation." */
  bootstrapping?: boolean
```

Update the function signature of `FeedImpl` to destructure it with a default:

```ts
  bootstrapping = false,
```

- [ ] **Step 3: Gate auto-scroll on bootstrapping**

Replace the auto-scroll effect (currently near Feed.tsx:641, the block that computes `semanticTurnSignal` and calls `el.scrollTop = el.scrollHeight`) with:

```ts
  // Auto-scroll on content changes, but ONLY when sticky AND not
  // currently in a bootstrap replay burst. See LazyEntry for the
  // cascade rationale — pinning per entry while the placeholder
  // observer fires mounts causes the visible "scroll through the
  // transcript" bug during resume.
  const semanticTurnSignal = semanticTurn
    ? `${semanticTurn.turnId}:${semanticTurn.text.length}:${Object.keys(semanticTurn.blocks).length}`
    : ''
  useEffect(() => {
    if (bootstrapping) return
    if (!tailMode && !stickyBottomRef.current) return
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length, streamingScreen, tailMode, semanticTurnSignal, bootstrapping])

  // Single pin-to-bottom on the bootstrap → live transition. Runs
  // exactly once per transition thanks to the previous-value ref.
  const prevBootstrappingRef = useRef(false)
  useEffect(() => {
    if (prevBootstrappingRef.current && !bootstrapping) {
      const el = scrollerRef.current
      if (el && (tailMode || stickyBottomRef.current)) {
        el.scrollTop = el.scrollHeight
      }
    }
    prevBootstrappingRef.current = bootstrapping
  }, [bootstrapping, tailMode])
```

- [ ] **Step 4: Pass `suspended={bootstrapping}` into every LazyEntry**

Inside the `visible.map(...)` render (search for `<LazyEntry eager={eager}`), update:

```tsx
                <LazyEntry eager={eager} scrollerRef={scrollerRef}>
                  <EntryRow entry={e} />
                </LazyEntry>
```

to:

```tsx
                <LazyEntry
                  eager={eager}
                  suspended={bootstrapping}
                  scrollerRef={scrollerRef}
                >
                  <EntryRow entry={e} />
                </LazyEntry>
```

- [ ] **Step 5: Consume tool indices from runtime instead of rebuilding via useMemo**

Currently `Feed.tsx` declares two `useMemo` blocks that call `buildToolUseIndex(entries)` / `buildToolResultIndex(entries)` (around line 740-741). Those rebuild the whole map on every render. Replace them by accepting the maps as props:

Edit the `Props` type to add:

```ts
  toolUseIndex?: Map<string, ToolUseBlock>
  toolResultIndex?: Map<string, ToolResultBlock>
```

Edit `FeedImpl`'s destructure to include defaults:

```ts
  toolUseIndex,
  toolResultIndex,
```

Replace the `useMemo` block at Feed.tsx:740-741:

```ts
  const toolUseIndex = useMemo(() => buildToolUseIndex(entries), [entries])
  const toolResultIndex = useMemo(() => buildToolResultIndex(entries), [entries])
```

with:

```ts
  // Incremental indices are maintained by workspaceStore at
  // entry-ingest time (see workspaceState.ts + workspaceStore.ts).
  // Feed falls back to a one-shot build if the caller didn't pass
  // them in — preserves backward compatibility for any future
  // consumer that mounts Feed outside the workspace store.
  const resolvedToolUseIndex = toolUseIndex ?? useMemo(
    () => buildToolUseIndex(entries),
    [entries, toolUseIndex],
  )
  const resolvedToolResultIndex = toolResultIndex ?? useMemo(
    () => buildToolResultIndex(entries),
    [entries, toolResultIndex],
  )
```

And change the two context providers later in the file from `value={toolUseIndex}` / `value={toolResultIndex}` to `value={resolvedToolUseIndex}` / `value={resolvedToolResultIndex}`.

- [ ] **Step 6: Thread the new props from TileLeaf into Feed**

Open `src/renderer/src/tiles/TileLeaf.tsx` and find where `<Feed ... />` is rendered. Add to the props:

```tsx
            bootstrapping={runtime.bootstrapping}
            toolUseIndex={runtime.toolUseIndex}
            toolResultIndex={runtime.toolResultIndex}
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 8: Manual verification**

Run the dev build: `npm run dev`

1. Start cc-shell, open a Claude session, chat until the transcript has at least 30+ messages.
2. Quit and restart the app.
3. Observe the rehydrated pane. Expected:
   - No visible "scrolling through the conversation" cascade.
   - The pane lands at the bottom of the transcript within ~1 frame of the spawn resolving.
   - Scrolling up still progressively mounts older placeholders (confirming LazyEntry still works post-bootstrap).
4. Open devtools Performance tab, record a restart. The bulk `setRuntimes` should show as a single React commit instead of a long strip of sequential commits.

- [ ] **Step 9: Commit**

```bash
git add src/shared/ui/LazyEntry.tsx src/renderer/src/feed/Feed.tsx src/renderer/src/tiles/TileLeaf.tsx
git commit -m "$(cat <<'EOF'
perf(feed): suspend auto-scroll and lazy-mount during bootstrap

While runtime.bootstrapping is true, Feed skips the per-append
scroll-pin and LazyEntry keeps every placeholder dormant (no
IntersectionObserver attached). On the transition back to false a
single pin-to-bottom runs, so the viewport lands at the bottom of
the transcript in one paint instead of cascading through it.

Also switches Feed to consume the workspace-store-maintained
toolUseIndex / toolResultIndex. The in-Feed useMemo rebuilds were
O(N) per render × N renders during bootstrap — removing them drops
bootstrap work from O(N²) to O(N).
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- (1) Main→renderer batching: Task 1 adds the coalescer, Task 2 exposes it.
- (2) Single-pass prepend/append: Task 4 folds the whole burst in one setState.
- (3) Suspend auto-scroll during bootstrap: Task 5 Step 3.
- (4) Bigger EAGER_TAIL or suspend lazy-mount: chose suspend (Task 5 Step 1+4). EAGER_TAIL stays 30 — suspending is cleaner than tuning.
- (5) O(N²) useMemo rebuild: Task 3 + Task 4 + Task 5 Step 5 move indexing incremental.

**Placeholder scan:** All task steps contain concrete file paths, concrete code blocks, and concrete commands. No TBDs.

**Type consistency:** `bootstrapping`, `toolUseIndex`, `toolResultIndex` names are used consistently across state, store, and Feed. `indexEntryIntoMaps` is defined in Task 4 Step 2 and used in Steps 3 + 7. `SessionJsonlEntriesEvent` is defined in Task 2 and consumed by name in Task 4.
