# cc-shell rendering harness

Standalone Electron app for **working on the rendering engine in
isolation**. The harness reproduces cc-shell's full rendering pipeline
— PTY → JSONL → proxy SSE → mapper → Feed component tree — against
real, live agent sessions, with every layer exposed side by side so
visual regressions can be traced to the layer that broke.

If you are debugging or extending **only** the rendering layer, work
here. Edits to vendored render components in this folder do **not**
touch cc-shell. Edits to data-plumbing modules under `src/` (parsers,
transcript types, workspaceStore mappers, settings store) DO affect
cc-shell — by design, so a regression in one app reproduces in the
other.

No tabs. No command palette. No workspace. One session, one window,
every stream visible at once.

---

## Isolation model

| Layer                                | Location                                                 | Shared with cc-shell?  |
|--------------------------------------|----------------------------------------------------------|------------------------|
| Render UI (Feed, rows, code, git)    | `testing/rendering/renderer/components/`                 | **No** — vendored copy |
| Harness shell + debug panels         | `testing/rendering/renderer/RenderingHarnessApp.tsx`    | No                     |
| Main process (sessions/IPC)          | `testing/rendering/main.ts`                              | No                     |
| Preload bridge                       | `src/preload/index.ts`                                   | Yes (reused)           |
| Transcript types                     | `src/shared/types/transcript.ts` + provider types        | Yes                    |
| Parsers (extract / screen / git)     | `src/shared/parsers/`, `src/shared/git/`                 | Yes                    |
| Workspace mappers + semantic fold    | `src/renderer/src/workspace/workspaceStore.ts` (pure exports)| Yes                    |
| Settings store + theme               | `src/renderer/src/state/`                                | Yes                    |
| Headless PTY runtimes / providers    | `src/providers/`, `claude-code-headless`, `codex-headless` | Yes                  |

The vendored render layer is a **one-time copy** with manual sync.
When cc-shell ships a real Feed/row fix, port it into the vendored
copy by hand. When you want to experiment with rendering only here,
edit only the files under `testing/rendering/renderer/components/`
and cc-shell is untouched.

## Run

```bash
npm run testing:rendering          # build + launch
npm run testing:rendering:build    # build only
npm run testing:rendering:preview  # launch from existing build
```

Output lives under `testing/rendering/out/` — separate from cc-shell's
`out/`, so the two builds never clobber each other.

## What you see

**Phase 1 — session picker.** Scans `~/.claude/projects/**/*.jsonl`
and `~/.codex/sessions/**` directly. Every past session, newest first,
filterable. Click one to resume.

**Phase 2 — debug split view.** Top bar shows provider, resumed
session id, cwd, layer counts, isLive gate, current turn id, baseline
length, close button.

Left column — the real rendered Feed plus a composer that pipes input
directly into the agent's TUI.

Right column, stacked:
- **Raw terminal** — plain TUI screen snapshot + collapsed markdown
  reconstruction. Upstream of every parser.
- **Raw JSONL** — every entry as it lands on disk, newest first,
  click to expand. Upstream of the feed mapper.
- **Semantic events** — per-block events from the Claude proxy
  adapter / Codex Responses adapter (or screen-fallback deltas).
- **FAT debug stream** — unified per-layer log:
  - `JSONL` — each raw entry's shape
  - `MAP` — mapper kept/dropped per entry, with reason
  - `SEM` — every semantic event (per-token deltas rolled up)
  - `STATE` — spawn / exit / process state / history loads / baseline capture
  - `RENDER` — for each appended feed entry, the exact dispatcher path
    each block will take (`EditRow`, `ToolUseRow(Bash)`, `TextProse(N)`, …)

  Filter chips toggle each layer. Copy buttons (`copy 50`, `copy 200`,
  `copy all`) snapshot the visible view.

## Bug-fix registry

Tickets here track **cc-shell rendering bugs** that the harness
helped us reproduce or fix. Harness setup mistakes (wrong CSS, hook
order, etc.) are NOT in this list — see "Harness architecture notes"
below for those.

Every ticket is referenced from a thick WHY-comment at the patch
site so future-you can jump from code to context and back.

| Ticket   | Bug in cc-shell rendering                                                                                                                                                                                                                              | Harness patch site                                                                                                | cc-shell status                                                                                                       |
|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| REND-1   | Bootstrap race: bulk `session:jsonl-entries` burst (~200 entries) fires inside `await spawnSession()`. Any consumer that subscribes AFTER spawn returns drops the entire bootstrap. Visually: only the very last message appears.                       | `RenderingHarnessApp.tsx` — subscriptions hoisted to App level, refs reset before `spawnSession`                  | Fixed: `workspaceStore` subscribes at module mount, before any spawn.                                                  |
| REND-2   | "Double-rendered last message" on resume. The screen still contains the last assistant message, so `<StreamingRow>` extracts and renders it AT THE SAME TIME the JSONL bootstrap renders it as an `<EntryRow>`. Both visible.                          | `RenderingHarnessApp.tsx` — `isLive` gate on `streamingScreen` prop (mirror of `TileLeaf.isSessionLive`)          | Fixed: `TileLeaf.isSessionLive` zeroes `streamingScreen` when no turn is in flight.                                    |
| REND-3   | After submitting a prompt, the previous assistant text rendered below the user message until the new turn's first text_delta. Two root causes: (a) no `streamingBaseline` captured at submit, (b) proxy semantic events were never folded into a `SemanticLiveTurn` so Feed always fell back to `<StreamingRow>` (screen scrape) instead of `<SemanticStreamingTurn>` (parsed events). | `RenderingHarnessApp.tsx` — `foldSemanticEvent` fold + `onBeforeSubmit` baseline capture                          | **PARTIAL.** cc-shell captures the baseline (`TileLeaf.tsx` onSubmit) and folds events, but `Feed.tsx isStaleStreamingExtract` early-returns false for Claude — only Codex gets the prefix-containment heuristic. Claude can still flicker the previous turn's text during the submit→first-delta gap. |

### Adding a new ticket

1. Pick the next `REND-N`.
2. Add a row to the table above (one-line summary + harness patch site
   + cc-shell status: fixed / partial / not fixed).
3. At the harness patch site, write a thick WHY-comment that **starts**
   with the ticket id, e.g.
   ```
   // REND-4 — older-history prepend dropped compact_summary entries.
   //
   // Reason: the prepend loop only ran the conversation/compact filter
   // once, but compact_summary is wrapped in a `progress` envelope that
   // had to be unwrapped first. Mirror of workspaceStore's loadOlder
   // path in cc-shell.
   ```
4. Commit with the ticket id in the subject: `REND-4: …`.

## Harness architecture notes

Items below are **NOT** cc-shell bugs — they are harness setup
decisions / first-cut mistakes documented here so future maintainers
don't re-litigate them. None of these have a ticket id; they're
just constraints of the harness itself.

- **Dedicated main process** (`testing/rendering/main.ts`): the
  harness does NOT reuse `src/main/index.ts`. That entrypoint boots
  tmux detection, workspace persistence, switch-provider, LSP, fs
  helpers — all log noise and timing variance that hides real
  rendering bugs. The harness main only wires the session
  IPC channels its renderer talks to and stubs the rest.
- **Subscribe-before-spawn**: REND-1 in the registry. Hooks here
  for cross-reference.
- **flex-row split, not grid-cols**: a single-row CSS grid resolves
  row height to `auto`, which collapses Feed's `h-full overflow-auto`.
  The split between rendered feed and debug panels uses `flex` for
  this reason.
- **Hook order**: every hook above any conditional `return`. Easy
  to violate when refactoring; React error #310 is unhelpful.
- **`process` global is not available** in the renderer (Electron
  contextIsolation). Use constants for fallback paths.
- **Vendored UI render layer**: `Feed.tsx`, row dispatchers,
  `CodeBlock`, `GitRows`, `monacoRuntime` are vendored at
  `renderer/components/`. Edits stay in the harness; data plumbing
  is shared. Bottom padding inside the vendored Feed (`pb-24`) is
  larger than cc-shell's (`pb-8`) because the harness has a tighter
  pane.
- **FAT debug stream**: per-layer debug log
  (`JSONL` / `MAP` / `SEM` / `STATE` / `RENDER`) so a regression can
  be traced to the layer that broke.

## Adding a new debug-stream layer

`DebugLayer` is a discriminated union in `RenderingHarnessApp.tsx`.
To add e.g. a `PTY` layer:

1. Append `'PTY'` to the `DebugLayer` union.
2. Add a color in `LAYER_TEXT` and `LAYER_BORDER`.
3. Push events from the relevant subscription handler:
   ```
   pushDebug({ layer: 'PTY', kind: 'data', summary: `${bytes} bytes` })
   ```
4. The filter chip and copy buttons pick it up automatically.

## Required cc-shell additions

Some additions in `src/` exist purely to support this harness. They
are pure additions — no existing cc-shell behavior changed.

- `session:list-all` IPC handler in `src/main/index.ts`
- `listAllSessions` API in `src/preload/index.ts`
- `listAllClaudeSessions` exported from `src/providers/claude/runtime/sessionList.ts`
- `mapCodexRolloutToFeedEntries`, `extractEmbeddedClaudeProgressEntry`, `claudeHistoryMarker`, `codexHistoryMarker`, `foldSemanticEvent` exported from `src/renderer/src/workspace/workspaceStore.ts`

If the harness build complains about a missing export, that export
needs to be added to cc-shell — never duplicate the implementation
into the harness; the whole point is that the data layer stays
shared.
