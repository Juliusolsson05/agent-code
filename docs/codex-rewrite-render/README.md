# Codex Render Rewrite Notes

This directory is the working notebook for rebuilding feed rendering from first principles while keeping live streaming.

## Current Principle

The feed renderer must not blend sources opportunistically. It should select from explicit owners:

- `committed`: durable transcript / rollout entries.
- `semantic-history`: completed live turns that are still waiting for committed catch-up.
- `semantic-current`: the current live streaming turn.
- `work`: phase-only agent activity, independent from text rows.
- `empty`: placeholder when no row owner has content.

The first implementation pass introduces `deriveFeedRenderModel` in `src/renderer/src/features/feed/model/renderModel.ts`. `Feed.tsx` now asks that selector what to paint instead of recomputing committed visibility, semantic ownership, and RENDER debug rows inline.

## Findings

- `upstream-codex-rendering.md`: Codex upstream separates raw provider deltas, core UI events, and rollout persistence. We should keep those layers distinct.
- `headless-channel-model.md`: headless exposes semantic, screen, and committed planes. Screen may drive diagnostics/phase, but it must not be a second assistant-text owner in Feed.
- `renderer-runtime-ingestion.md`: renderer state already contains committed entries, semantic current/history, ghosts, and stream phase. The bug class appears when those owners are selected in separate JSX branches.
- `feed-ui-rendering.md`: Feed had many local duplicate guards, but no single visible-unit selector.
- `submit-queue-debug.md`: draft/submitted/queued/committed prompt states are different owners; queued prompts should not become transcript rows.

## Implemented In This Branch

- Extracted a pure render selector:
  - committed entry visibility decisions,
  - Claude-only semantic-history turn suppression,
  - Codex-safe semantic unit suppression via committed tool/text ownership,
  - independent work-row modeling,
  - RENDER debug rows derived from the same model Feed uses to paint.
- Exported semantic ownership helpers from `renderUnits.ts` so debug/model decisions cannot claim a semantic row that `SemanticStreamingTurn` would later return as `null`.
- Added stable current semantic turn keys and turn-scoped semantic block keys.
- Added `scripts/test-feed-render-model.ts` and `npm run test:feed-render-model`.

## Remaining Work

- Move more semantic ownership out of React components and into the selector so Feed can eventually render a single typed `FeedRenderItem[]`.
- Add a renderer trace command that logs committed, semantic, and work owner candidates before selection and after selection.
- Investigate the Codex headless rollout lifecycle issue documented in `headless-channel-model.md`: rollout `agent_message_delta` may need to soft-open a semantic turn before applying deltas.
