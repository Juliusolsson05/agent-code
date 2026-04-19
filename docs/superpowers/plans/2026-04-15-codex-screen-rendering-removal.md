# Codex Screen Parsing In Main Rendering

## Goal

Remove screen-derived assistant text from the main Codex rendering flow.

Target policy:

- Screen parsing is allowed for command / modal / detection UI:
  - approval overlays
  - trust dialogs
  - activity / working status
  - similar terminal-control surfaces
- Screen parsing is not allowed to drive the main assistant rendering flow.
- If the user wants Codex agent mode with live streaming assistant text, require a working proxy path and treat proxy or rollout as the only valid content sources.

## Design Position

The codebase already has the right conceptual model in `codex-headless`:

- `semantic` = what Codex is producing right now
- `screen` = what the terminal is painting right now
- `committed` = what the rollout file has durably written

The problem is not the model. The problem is that the renderer still has legacy fallback paths where screen parsing leaks into the assistant content path.

That is the thing to remove.

## Current Policy Problem

Today the renderer still accepts screen-derived assistant text in three ways:

1. Direct screen extraction in the main feed.
2. Direct screen extraction in the reader view.
3. Screen-sourced semantic events being folded into the live semantic turn with no gating.

This means the UI can present assistant content that originated from `extractAssistantInProgress(...)` even though the package-level design says screen parsing should be fallback-only and lower trust.

## Exact Occurrences

### 1. `Feed.tsx` renders screen-extracted assistant text

File:

- `src/renderer/src/feed/Feed.tsx`

Relevant code:

```tsx
const plainExtract = extractAssistantInProgress(screen, currentProvider)
...
return (
  <MarkerRow marker="⏺">
    {display ? (
      <StreamingProse text={display} />
    ) : (
      ...
    )}
  </MarkerRow>
)
```

Why this matters:

- This is not a debug path.
- This is not command-state UI.
- This is the main live assistant bubble in the feed.

Upstream plumbing:

- `TileLeaf.tsx` passes `runtime.recentScreen` and `runtime.recentScreenMarkdown` into `Feed` as `streamingScreen` / `streamingScreenMarkdown`.
- The comment there explicitly says screen parsing is still supported as fallback.

That fallback is exactly what we want to remove from the main rendering path.

### 2. `ReaderView.tsx` falls back to screen extraction

File:

- `src/renderer/src/features/reader/ui/ReaderView.tsx`

Relevant code:

```tsx
const semanticText = semanticLive?.text?.trim() ?? ''
const live = semanticText
  || (runtime.recentScreen
    ? extractAssistantInProgress(runtime.recentScreen, provider)?.trim() ?? ''
    : '')
```

Why this matters:

- The reader is building a user-facing assistant message list.
- When semantic is empty, it still falls back to screen-extracted assistant text.

That is still main rendering, just in a different surface.

### 3. `foldSemanticEvent(...)` accepts `source: 'screen'` into live semantic state

File:

- `src/renderer/src/tiles/workspaceStore.ts`

Relevant behavior:

- `window.api.onSessionSemanticEvent(...)` feeds every semantic event through `foldSemanticEvent(...)`.
- `foldSemanticEvent(...)` copies `ev.source` onto `currentTurn.source`.
- It does not reject `source: 'screen'` or `confidence: 'fallback'`.

Effect:

- A screen-sourced semantic turn can become `runtime.semantic.currentTurn`.
- Any renderer reading `runtime.semantic.currentTurn.text` is therefore not guaranteed to be reading rollout/proxy text.

This is the hidden leak because even surfaces that think they are using the semantic channel may still be consuming screen-derived content.

## Occurrences That Are Fine

These uses of screen parsing match the intended policy and should stay:

### Approval overlay detection

File:

- `src/renderer/src/tiles/workspaceStore.ts`

Why it is OK:

- The approval overlay is terminal UI state.
- Screen is the correct source for dynamic option selection / highlighted choice / live overlay text.
- JSONL remains authoritative for command identity fields like `callId`.

### Trust dialog detection

Source:

- `codex-headless` trust dialog parser and screen channel events

Why it is OK:

- This is modal terminal state, not assistant content.

### Activity / working status

Source:

- `detectCodexActivity(...)`
- `process-state` forwarding

Why it is OK:

- This is status UI, not assistant output.

### Baseline capture for stale-stream detection

File:

- `src/renderer/src/tiles/TileLeaf.tsx`

Why it is probably OK:

- It is not directly rendered as assistant content.
- It is being used as comparison infrastructure when the user hits Enter.

This can stay unless we later simplify the streaming baseline logic around a proxy-only live path.

## Proposed Policy

### Rendering policy

For Codex main assistant rendering:

- valid content source: `proxy`
- valid content source: `rollout`
- invalid content source: `screen`

More concretely:

- main feed assistant streaming must come from semantic state whose source is `proxy` or `rollout`
- reader live assistant text must come from semantic state whose source is `proxy` or `rollout`
- screen-derived semantic events must not be folded into renderer live-turn state

### Product policy

If agent mode needs live streaming:

- require proxy support

If proxy is unavailable:

- do not fall back to screen-derived assistant prose
- either:
  - degrade to rollout-only rendering with delayed updates, or
  - block / disable the live agent-mode experience with an explicit product message

Given the goal stated here, the cleaner policy is:

- Codex agent mode requires proxy

That keeps the data contract simple and prevents the renderer from drifting back into screen-scrape-as-content behavior.

## Removal Plan

### Phase 1. Stop the direct rendering leaks

1. Remove the `Feed.tsx` screen-extraction rendering path for Codex live assistant content.
2. Remove the `ReaderView.tsx` direct screen fallback.
3. Stop passing `streamingScreen` / `streamingScreenMarkdown` into Codex main assistant rendering, or make them debug-only.

Expected result:

- no user-facing assistant prose in feed or reader is produced by `extractAssistantInProgress(...)`

### Phase 2. Enforce semantic provenance

1. Gate `foldSemanticEvent(...)` so `source: 'screen'` events are not folded into `runtime.semantic.currentTurn` for Codex content rendering.
2. Keep the raw event available for debug inspection if needed, but do not let it become live assistant content state.

Expected result:

- `runtime.semantic.currentTurn` becomes trustworthy for main rendering
- “semantic” actually means proxy/rollout semantic, not maybe-screen

### Phase 3. Formalize the proxy requirement

1. Define Codex agent-mode startup behavior when proxy is disabled or unavailable.
2. Prefer failing early with a clear message over silently falling back to screen parsing.
3. Keep rollout as the durable fallback source for history and delayed updates.

Expected result:

- live Codex assistant rendering has a clear prerequisite
- no more invisible fallback from structured stream to screen scrape

## Suggested Implementation Shape

### A. Remove feed fallback

Current state:

- `Feed` receives `streamingScreen`
- `StreamingRow` parses screen text directly

Target state:

- Codex live row renders from `semanticTurn` only
- if semantic/proxy is absent, show status or nothing, but not screen-derived prose

### B. Remove reader fallback

Current state:

```tsx
const live = semanticText || screenExtract
```

Target state:

```tsx
const live = semanticText
```

### C. Filter screen provenance in semantic reducer

Current state:

- `foldSemanticEvent(...)` accepts `source: 'screen'`

Target state:

- Codex rendering reducer ignores screen-sourced semantic content events
- optionally preserve them only in debug-only state if there is value in inspecting them

## Open Product Decision

One decision should be made explicitly before the patch series:

- Should Codex agent mode hard-fail without proxy?

Recommended answer:

- yes, for live agent-mode rendering

Rationale:

- the proxy path gives the correct low-latency semantic source
- rollout remains the durable source of truth
- screen parsing can stay for commands / detection
- removing screen-as-content becomes enforceable instead of aspirational

## Practical Acceptance Criteria

The work is done when all of the following are true:

- `extractAssistantInProgress(...)` is not used to render live Codex assistant prose in the main feed
- `extractAssistantInProgress(...)` is not used to render live Codex assistant prose in the reader
- screen-sourced semantic events do not populate `runtime.semantic.currentTurn`
- approval / trust / activity screen parsing still works
- Codex live agent-mode rendering is backed by proxy or rollout only
- proxy requirement for agent mode is documented in code and product behavior

## Summary

The issue is not that screen parsing exists.

The issue is that screen parsing still leaks into content rendering.

The fix is to make the architecture obey its own model:

- screen for terminal-state detection
- rollout for durable semantic truth
- proxy for live semantic truth
- no screen-derived assistant prose in the main rendering flow
