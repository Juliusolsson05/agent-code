# A failed "load older history" is said, not just un-spun (#1250 row 12)

Short plan: a bug with a known root cause. The row comes from `temp/quality-loop/hunt-c3.md` (row 12, P3). #1250 is a batch issue, so this PR is `Refs #1250`.

## Outcome
Scrolling to the top of an agent's feed pages in older history. When that page fails to load (an IPC error, or an unreadable transcript), the user is told, and learns how to retry. Today the catch in `useHistoryActions.loadOlderHistory` only clears `loadingOlderHistory`. The feed looks as if it simply has nothing older, although `hasOlderHistory` is still true.

## Root cause (verified in source, origin/main)
- `src/renderer/src/workspace/hook/actions/history.ts`: on catch, it records a perf failure, warns to the console, and patches `loadingOlderHistory: false`. It returns `void` whatever happened, so no caller can tell a failure from a load.
- `TileLeaf.loadOlderHistory` awaits it and discards the result. `Feed` retries only on a NEW scroll event within 160 px of the top.

## Design (contract)
- **`loadOlderHistory(sessionId): Promise<'loaded' | 'skipped' | 'failed'>`** (`OlderHistoryLoadResult`, exported from `history.ts`).
  - `failed` only from the catch; `skipped` from every early return; `loaded` after the merge.
- **`TileLeaf`** shows a pane toast on `failed`: "Couldn't load older messages. Scroll up again to retry."
  - Fixed text (q22): the error can carry a transcript path.
  - Coalesced to one per 5 s per pane. While the scroller stays near the top, every scroll tick retries, and each failure must not stack another toast.
  - It is a PANE toast because the failure belongs to this feed.
- `AgentFeed` and `Feed` keep `onLoadOlderHistory: () => Promise<void>`. The phone mounts the same `AgentFeed` and is untouched.

## Tests
- **`history.renderer.test.tsx`:** a rejecting `loadOlderHistory` IPC gives `failed` and leaves `hasOlderHistory` true (a retry stays possible). A successful page gives `loaded`; a missing marker gives `skipped`. Red on main: the result is `undefined`.
- **New `TileLeaf.olderHistory.renderer.test.tsx`:** with Feed probed for its `onLoadOlderHistory` prop and `workspace.loadOlderHistory` answering `failed`, the pane toast shows the fixed text once across two quick failures, and not at all on `loaded`. Red on main: no toast.

## Verification boundary
Renderer tests drive the real hook and the real TileLeaf. The app is not launched.

## Out of scope
- #1250's other rows.
- A persistent inline "retry" affordance in the feed header (a design call; the toast plus the existing scroll retry is enough to end the silence).

## Steering q106
- The dispatch layout re-renders the SAME TileLeaf with another agent's `sessionId` when a lane switches. One timestamp per mounted leaf therefore let agent A's toast silence agent B's first failure for 5 s.
- The cooldown is now keyed by `sessionId`. Test: same-leaf rerender, A fails and toasts, the lane switches to B, B fails and toasts, and B's repeat still coalesces. It fails with the per-leaf timestamp.

## Review round 1 (a, b: FIX-BEFORE-MERGE)
- **a (Major): an unreadable transcript was paged as an empty page with `hasMore: false`.** The main-side `readOlderTranscriptWindow` swallowed stat/open/read failures, so the renderer dropped "older history exists" and returned `loaded`.
  - **Ruling:** this reader serves only older paging, so a failure now rejects. The page is reported `failed` and stays retryable. An empty file (stat succeeded, size 0) is still an honest empty page, and the initial-chunk reader is unchanged.
  - Test in `historyLoader.test.ts`: the first page loads, the file is removed, the older page rejects with ENOENT, and an empty file stays empty. It fails on the old loader.
  - This landed in `e905104e`, whose message names only q106.
- **a, b (Major): "Scroll up again to retry" was impossible at the top.** At `scrollTop` 0 an upward gesture fires no scroll event, and Feed triggered only on scroll. An upward wheel at the top now makes the same request.
  - Test: the real Feed, two upward wheels at 0, two requests (red on the old Feed). A downward wheel makes none. It also kills a's survivor (`loadingOlderRef` left true).
- **b (Major): the cooldown was shared across agents in one lane.** This is q106, fixed.
- **b (Minor): the raw error still reaches `console.warn` and the perf span.** Declined: these are developer diagnostics, not user-visible text (q22 governs what the user sees). The perf journal already records file paths on this path by design (`finishOlderChunk`).
- **c (MERGE-READY; four test gaps, each pinned):**
  - every early return answers `skipped`;
  - a retry 1 s into the window stays suppressed;
  - the toast text is asserted literally;
  - the toast goes to this pane.
  c's mutations M7 (no-older → failed) and T3 (5 s → 500 ms) now fail.
- **Verification b (Major): the touch form of the gesture was still missing.** A downward finger drag at the top now makes the same request. Test with the real Feed: an upward drag makes none, a downward one makes one. It fails on the previous Feed.
- **Verification a (Major): a Codex rollout the resolver could no longer find still made an older page an empty `hasMore: false`.** `loadOlderHistoryChunk` returned that before reaching the now-strict reader. An older page with an unresolvable transcript now rejects. The perf span fails, and the phone's `RemoteServer` already turns a throw into a structured `ok: false`. Test in `historyLoader.providerOwned.test.ts` (Codex, resolver returns null), red on the previous loader.
