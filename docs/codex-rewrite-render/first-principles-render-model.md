# First-Principles Feed Render Model

## The Problem

The recurring rendering bugs come from treating "things we know about the session" as "things React should paint." A session can simultaneously contain:

- committed transcript rows,
- a semantic live turn,
- archived semantic turns waiting for transcript catch-up,
- optimistic local submit rows,
- queue-strip prompts,
- ghost recovery entries,
- stream phase updates.

Those are not equal. Some are durable UI, some are temporary live UI, some are diagnostics, and some are future work. The renderer breaks when two of them both believe they own the same visible assistant slot.

## The Rule

Every visible feed surface needs one owner.

Committed transcript entries own durable history. Semantic current owns live streaming assistant content. Semantic history owns only live leftovers that are still renderable after committed catch-up. Work owns activity state even when no assistant text exists. Empty owns the placeholder.

The model should answer three questions before JSX runs:

1. Which committed entries are visible?
2. Which semantic turns still have renderable units after committed ownership is applied?
3. Which non-message affordances, such as work or empty, should exist?

## Why Semantic Renderability Belongs In The Model

`SemanticStreamingTurn` can return `null` when:

- a turn has no blocks and no text,
- a live text-only turn exactly matches committed assistant text,
- every block in a semantic turn is already owned by committed tool/text rows.

Before this branch, RENDER debug rows were created before that check. Debug could say a semantic row existed while React painted nothing. That is poison for this bug class because the evidence lies about ownership.

The selector now calls `semanticTurnHasRenderableContent` before adding semantic rows to the model. `SemanticStreamingTurn` still performs the same suppression when painting, but debug and paint now agree.

## Claude Versus Codex

Claude committed assistant rows usually carry `message.id === semanticTurn.turnId`. That makes whole-turn suppression safe for archived Claude semantic history.

Codex is different. Rollout can commit one response item at a time. A committed tool item may carry the broad `codexTurnId` while live assistant text from the same broader turn is still uncommitted. Whole-turn suppression by Codex turn id would hide valid live output.

So Codex duplicate suppression stays at semantic-unit level:

- committed assistant text suppresses identical finalized live text,
- committed tool-use ids suppress matching live tool/output units,
- a semantic turn is suppressed only when all of its units are suppressed.

## Work Is Not Text

`streamPhase !== 'idle'` must always produce a work surface, even when no semantic turn exists or when a semantic turn is suppressed as a duplicate. Fresh submit, request wait, tool wait, and queued follow-up states are lifecycle facts, not text rows.

This is why the render model can produce `empty + work`: no row owns content yet, but the agent is still busy.
