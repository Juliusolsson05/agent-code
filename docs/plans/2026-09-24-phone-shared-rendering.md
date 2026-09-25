# Phone on the shared rendering seams (#1177)

Status: in progress (branch `refactor/phone-shared-rendering`).

## Why

The phone companion (`src/remote-client`) mounts the real desktop `Feed`, but
gets there by copying code instead of sharing it. Every copy has drifted. Some of
the drift is visible as worse phone rendering, not just duplicated code:

| Divergence | Desktop | Phone |
| --- | --- | --- |
| Feed entries | `selectMergedEntries` (ghost fallback) | raw `entries` |
| Conditions | provider `normalizeConditions`, then `ProviderConditionOutlet` | raw snapshot, core `ConditionOutlet`, own dispatch |
| Collapsed-running rule | real `lastJsonlEntryAt` | hardcoded `0`, rule never fires (ARCHITECTURE §8.3) |
| Main-side ordering barriers | semantic 100 ms coalescer flushed before JSONL / boundary / removal | none: semantic events cross uncoalesced and unordered against JSONL |
| Channels | 13 | missing `transcript-diagnostic`, `provider-session-changed` |
| Sub-agent watcher | one | a second, identical watcher polling the same dirs |
| History | `window.api.loadInitialHistory` + actions | `WebSocketSessionFeed.getHistory`, not on the contract |
| Feed prop mapping | `TileLeaf.tsx` | hand mirror in `SessionView.tsx`, citing stale line numbers |
| Host services | real `window.api` | six Vite aliases; the store stub is not type-checked |

That drift is why the phone keeps looking broken after so many fixes. Each fix
lands in one copy.

A second consumer is coming: a small viewer app that runs live agents and
screenshots how they render, so agents can iterate on rendering by looking at it.
It needs exactly the same seams. Building those seams once, properly, now makes
both the phone and the viewer thin.

## Principle

One implementation per concern, with the transport or host injected. The phone,
the desktop and the future viewer are different **sinks and hosts** over the
same code. They are not separate implementations of it.

This deliberately **reverses** part of the remote isolation doctrine in
`SessionFeed.ts` and `SessionFeedSource.ts`. That doctrine said "remote adapts
to core, core never grows remote-shaped parameters", and it accepted duplication
as the price. The duplication turned out to be where the bugs live. The new
seams are **transport-neutral**, not remote-shaped, so the part of the doctrine
that matters still holds: the phone cannot express spawn, kill, raw PTY or
provider switching, because the command surface keeps its shape.

## Stages

Each stage is one or more coherent commits. The PR ships all of them together:
they are coupled, and the phone only improves once the last one lands.

### Stage 1: one main-side session feed tap

- New `src/main/sessions/sessionFeedTap.ts` holds the ordering and batching that
  both paths need today:
  - latest-per-session screen and process-state coalescers;
  - the semantic coalescer with its barrier flushes;
  - JSONL burst coalescing (the module-global state in `jsonlCoalescer.ts`
    becomes per-tap instance state);
  - the single `SubAgentWatcherManager`.
  - It emits `(channel, payload)` to any number of sinks, and knows nothing about
    windows, Electron or sockets.
- The desktop `forwarder.ts` becomes the **window sink**. It maps channels to IPC
  names and routes through `sendToSessionWindow`. It keeps the broadcast-only
  events (managed skills, user MCP, LSP diagnostics).
- `SessionFeedSource` becomes the **remote sink** over the same tap:
  - It keeps the session-list tracking.
  - Its terminal gate becomes a sink-side filter, still one choke point.
  - Its raw-PTY exclusion still holds: the tap never forwards raw PTY bytes to a
    sink that did not ask for them. The window sink subscribes to them; the
    remote sink does not.
  - The phone gains the ordering barriers, `transcript-diagnostic` and
    `provider-session-changed`.
  - The duplicate sub-agent watcher is deleted.
- Late-joiner seeding (`flushSession`) stays a tap method.

### Stage 2: history on the SessionFeed contract

- `SessionFeed` gains `loadHistory(request)`, with one request/reply type in
  `@shared/sessionFeed/types` covering the initial load and older pages.
  - `IpcSessionFeed` maps it to the preload calls.
  - `WebSocketSessionFeed` maps it to `get-history`, and its extra `getHistory`
    method goes away.
- The desktop `initialHistory.ts` and older-history action read through the feed
  instead of `window.api`. The existing `readHistory` injection point becomes the
  feed.

### Stage 3: one session ingest core

- New `src/renderer/src/session-runtime/ingest/` contains the pure per-session
  folds both clients run:
  - **Committed transcript:**
    - the seen-uuid gate;
    - kind-routed mapping, with a live mapper whose cursor lasts for the session
      and a fresh mapper per history chunk;
    - tool-index maintenance and the version bump;
    - history prepend and live append;
    - transcript-roll detection and the live-window trim.
  - **Live:** semantic fold plus stream phase, conditions, sub-agents, the
    history-boundary decision, and exit.
- The phone `TranscriptStore` becomes a thin subscribable shell over the core.
- The desktop `useIpcSubscriptions` Pass B and the semantic handler call the
  same folds. Desktop-only planes stay layered on top in the desktop hub:
  - Claude queue attribution;
  - optimistic and ghost reconciliation;
  - worktree projection;
  - foreign-transcript quarantine;
  - feed-debug.
- This is **one ingest core, not one store**. The desktop's workspace-coupled
  planes have no phone equivalent, and forcing them into a shared store would
  make the phone carry state it can never populate.

### Stage 4: typed renderer host

New `src/renderer/src/features/rendererHost/` holds a `RendererHost` context.
It replaces the Vite aliases and the direct `window.api` calls inside the feed
subtree. It provides:

- `openExternalUrl`, and inline-code "open in editor" (nullable: the phone has no
  editor);
- the toast sink;
- `CodeBlock`: the desktop host supplies the Monaco/LSP component, the phone host
  the light one. Monaco is statically imported only by the desktop host module,
  so it stays out of the phone bundle without an alias.
- perf spans;
- render-shape evidence and session-recording hooks, which are no-ops on hosts
  without them, instead of try/catch around `window.api`;
- a typed read of the few app settings the feed subtree uses
  (`renderingDebugMode`, and so on). This replaces the untyped `appStateHooks`
  stub.

Also:

- `clearAgentComposer.ts` sends through the SessionFeed, not `window.api.sendInput`.
- The phone `vite.config.ts` loses its component and store aliases. Only the
  package-source aliases remain (`workflow-mcp/state`,
  `agent-transcript-parser/ghost`).

### Stage 5: one `AgentFeedView`

- New `src/renderer/src/features/feed/AgentFeedView.tsx` owns the mapping from a
  runtime slice to what gets painted:
  - `useLedgerFeedItems`, `selectMergedEntries` and `normalizeConditions`;
  - the `Feed` props;
  - the condition outlet, with one dispatch that carries the action id. Today
    the phone has `conditionDispatch.ts` and the desktop has
    `makeDispatchFromOnSend`; they merge into one.
- Desktop-only behaviour arrives as optional props: tail mode, pickers, scroll
  info, usage-limit actions, debug log, the workflow-view swap.
- `TileLeaf` and the phone `SessionView` both mount it. The phone gets the
  desktop's merged entries, normalized conditions and real `lastJsonlEntryAt`.

### Stage 6: provider policy through the registry

- `SUPPRESSION_POLICY` (`rendering/model/ownership.ts`) becomes a renderer
  capability.
- These inline checks become capabilities too:
  - `provider !== 'claude'` for the synthetic-user filter
    (`observations/committed.ts`);
  - `provider === 'opencode'` for no ghosts (`observations/ghosts.ts`);
  - `COLLAPSIBLE_CHURN_TOOLS`, the Claude tool names in `ownership.ts`.
- The silent `'claude'` fallbacks (`feed/context.tsx`, `Feed.tsx`,
  `replay/recordedSession.ts`) become explicit. An unknown provider is an error
  or a named default, never a quiet coercion.
- Grok and Pi register `shapes.ts` catalogs (empty where honest) in
  `registry.renderShapes.ts`.

### Stage 7: provider rows stop importing feed and workspace internals

- The feed primitives that provider rows legitimately use (`MarkerRow`,
  `ConversationRow`, the feed contexts, the evidence observer) move behind one
  `features/feed/public` module. That module is the only feed path providers may
  import.
- These imports are replaced by injection:
  - workspace imports in provider code: `SlashCommandPicker` → `workspaceStore`,
    and `composerSubmit` → `TileLeaf/claudePaste`;
  - the registry's `TileLeaf` import, whose per-provider slot is identical for
    all five providers and is deleted.
- The existing `importBoundaries.test.ts` gains the reverse rule. It extends a
  test that already exists; it does not add a new CI lock.

### Stage 8: docs in step

- ARCHITECTURE.md:
  - §5.4 and §8.3: tap, ingest core, host and AgentFeedView;
  - the remote sections: the doctrine change above;
  - §8.3 known gaps: phone `lastJsonlEntryAt`, and the phone missing the
    ghost/optimistic planes, where that is now intentional versus fixed.
- `docs/rendering/rendering-rewrite-plan-2026-07.md`: the stale flag/soak status
  and `view/` path become a `Status:` header pointing at what shipped.
- The header comments in `SessionFeed.ts`, `SessionFeedSource.ts` and
  `SessionView.tsx`.

## Out of scope, and why

- **Splitting `sessionManager.ts`.** It is messy, but neither the phone nor the
  viewer depends on its internals.
- **Phone chrome and CSS polish.** This PR fixes what the phone renders. Layout
  and styling problems are then fixable in one place, and the planned screenshot
  viewer is the tool for iterating on them.
- **The screenshot viewer itself.** It follows as its own PR, built on stages 1,
  4 and 5.

## Verification

- `npx tsc -b` (Node 24). Neither the build nor vitest type-checks.
- Existing suites that already pin these contracts:
  - `forwarder.test.ts`
  - `SessionFeedSource.test.ts`
  - `RemoteServer.*`
  - `WebSocketSessionFeed.*`
  - `transcript/store.*`
  - `useIpcSubscriptions.renderer.test.tsx` and the provider pane suites
  - `bundleCorpus` / `recordingCorpus`
  - `importBoundaries.test.ts`
- New tests only where a contract is new:
  - the tap's ordering barriers, per sink;
  - `loadHistory` parity across both feeds;
  - the phone and desktop producing the same ledger items from the same recorded
    session through the shared ingest core. This last one is the regression net
    for the drift this PR removes.
- `npm run client:build`: the phone bundle builds without the removed aliases,
  and Monaco is absent from it.
- The full `npm test` once at the end, not per stage.
- No app launch: per standing instruction, verification is by source and tests.
  Live phone checks are the user's call, or the viewer's once it exists.
