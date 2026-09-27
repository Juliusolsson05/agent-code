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
