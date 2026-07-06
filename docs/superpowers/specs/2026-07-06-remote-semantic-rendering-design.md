# Remote Semantic Rendering — the desktop feed on the phone

**Date:** 2026-07-06
**Status:** Approved direction (user delegated approach); implementation in progress
**Parent:** 2026-07-06-remote-mobile-companion-design.md · issue #420

## Problem

The shipped phone client renders the provider's raw TUI text. Correct, but it
discards the product's defining feature: the custom React transcript
rendering. The phone must render sessions with the SAME feed the desktop
shows — prose markdown, tool cards, diffs, todos, thinking blocks, streaming
turns, subagent cards — with no second renderer to drift.

## Decision: import the desktop feed, don't reimplement it

Three candidate architectures were evaluated against a full dependency audit
of the feed subtree (four parallel deep-reads; findings below):

1. **Reimplement mobile rows** sharing only parsers — permanent double
   rendering tax, guaranteed drift. Rejected: it is exactly the failure mode
   the MANIFESTO calls out.
2. **Vendor a copy of the feed** (what testing/rendering does) — same drift
   problem one directory over. Rejected.
3. **Import the REAL `@renderer` feed subtree into the phone bundle, with
   Vite-alias substitution for the (exactly four) Electron/desktop-coupled
   modules.** Chosen.

Why 3 is safe — the audit's load-bearing facts:

- `Feed.tsx` reads NOTHING from Electron or the app store itself; it renders
  from plain props (entries, semanticTurn/History, tool indices, subAgents,
  streamPhase…). TileLeaf.tsx:475-573 is the complete runtime→props map.
- `renderModel.ts` / `renderUnits.ts` (ordering + ownership/suppression — the
  hardest correctness logic) are pure.
- Every non-portable edge funnels through four modules, each cleanly
  substitutable at BUILD level via vite aliases:
  | desktop module | coupling | phone substitute |
  |---|---|---|
  | `@renderer/lib/code/CodeBlock` | monaco (dynamic import), LSP via window.api | static-only CodeBlock: same props, hljs `highlight`/`highlightAuto`, same `hljs` class markup (byte-identical tokens to the desktop's static engine) |
  | `@renderer/app-state/hooks` | zustand app store (ONE read: `settings.customRendering`, Block.tsx:55) | stub `useAppStore(selector)` over a static defaults object |
  | `@renderer/performance/client` | perf IPC | no-op metrics |
  | `SafeMarkdownLink` / `SafeInlineCode` | global editor, toast, window.api external-open | plain `<a target="_blank">` / `<code>` |
- Styling: the components are Tailwind-4 classed against the app theme
  tokens. The phone bundle adopts `@tailwindcss/vite` + imports
  `@renderer/styles.css` (the rendering harness proves this works outside the
  main app), keeping the existing mobile chrome CSS for the shell around the
  feed.
- Monaco is NOT dragged in: its import is dynamic inside the desktop
  CodeBlock, and that file is aliased away entirely. The desktop's own
  markdown fences/diffs/git output already use the static hljs engine, so
  phone output matches the majority of desktop surfaces exactly.

**The alias-substitution list is the phone's compatibility contract.** Every
alias is a declared, documented divergence; anything NOT aliased renders with
literally the same component the desktop uses. Adding an alias = a conscious
decision recorded in the vite config's comments.

## Client state model (the minimal SessionRuntime)

The phone maintains, per session (audit: workspaceState.ts:285-671 with the
feed-consumed field analysis):

- `entries: Entry[]` — mapper-produced, seen-uuid deduped
- `semantic: { currentTurn, history }` via the REAL `foldSemanticEvent`
  (pure; React-coupled only through the provider registry, fine in a React
  bundle)
- `streamPhase` + pending tool name/id + `turnStartedAt` — reduced OUTSIDE
  the fold, mirroring useIpcSubscriptions.ts:939-1028 (stream_phase events +
  turn_started/turn_completed bridge)
- `toolUseIndex` / `toolResultIndex` / `toolIndexVersion` via
  `indexEntryIntoMaps`
- `subAgents`, `conditions` (already on the wire)
- `lastJsonlEntryAt`, `historyOldestMarker`, `hasOlderHistory`, `totalEntries`
- per-session codex mapper turn cursor (the stateful mapper's cursor must
  survive across WS bursts, mirroring `codexCurrentTurnIdBySession`)

Deliberately SKIPPED subsystems (each returns identity/no-op when absent):
- **ghosts** — crash-recovery/JSONL-stall fallback only; with an empty Map,
  `selectMergedEntries` returns `entries` by identity. Revisit only if
  stalled-stream complaints show up on phone.
- screen buffers (feed no longer reads them), feed-debug, ghosts journal,
  optimistic user echo (phone has no local composer echo yet), provider
  quarantine (single-consumer stream).

Ingest discipline (must mirror the desktop exactly — audit §5/6):
- ONE seen-uuid Set per session gates BOTH backfill and live entries.
- History PREPENDS, live APPENDS.
- Pagination anchor = first kept entry's historyMarker; `totalEntries`
  authoritative only from the initial chunk.

## History over the wire

New read-only inbound message (scope widening, scope.test.ts updated in the
same diff):

```
{ type: 'get-history', sessionId, beforeMarker?, limit? }
→ reply result: { entries: RawRecord[], hasMore, totalEntries? }
```

Main-side key resolution: SessionManager cannot produce
`{cwd, providerSessionId}` for a live session (cwd is constructor-private;
providerSessionId only exists inside the jsonl). But the transcript FILE
path rides every `jsonl-entry` event. So:

- SessionManager gains a `lastTranscriptFile` cache (same pattern + lifetime
  as the screen/conditions snapshot caches added for late-joiner priming;
  fed at the jsonl-entry relay, cleared in cleanupSessionState) + getter.
  Because SessionManager lives from app boot, this covers sessions started
  long before remote was enabled.
- historyLoader gains path-based variants
  (`loadInitialHistoryChunkFromFile` / `loadOlderHistoryChunkFromFile`) —
  a refactor extracting the existing post-path-resolution body; the
  {kind,cwd,providerSessionId} entrypoints become thin wrappers. No behavior
  change for the desktop callers.
- RemoteServer's `get-history` handler = getTranscriptFile + kind → chunk.
  Raw records go over the wire in the live `{entry, file}` shape so the
  phone's ONE mapper path serves both backfill and live.

## Composer / conditions (unchanged scope)

The v1 control scope is untouched: prompts via deliverPromptToAgent,
interrupt, condition replies. The phone's condition tap-targets stay (they
already fail closed via the server-side live-menu check); adopting the
desktop's ProviderConditionOutlet is a possible later refinement, not part
of this slice.

## Risks / accepted costs

- **Bundle size**: react-markdown + remark + highlight.js + the feed tree.
  Estimated ~350-450 KB gzip (no monaco). Acceptable for a LAN/tunnel tool;
  measure at build and record.
- **Alias fragility**: a desktop refactor that moves one of the four aliased
  module paths breaks the phone build LOUDLY (vite resolve error) — which is
  the correct failure mode; the fix is updating one alias.
- **tsconfig coverage**: remote-client is type-checked under tsconfig.web
  with the REAL desktop modules (aliases are build-time only), so tsc keeps
  checking the true desktop types; the stubs are checked as standalone
  modules. The stub-vs-real interface contract is pinned by a test comparing
  the stub CodeBlock's props type to the desktop's.
