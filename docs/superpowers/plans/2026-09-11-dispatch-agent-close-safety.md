# Dispatch agent close safety

Status: implemented and locally verified; awaiting PR review and CI. Do not merge without user approval.

## Problem and intended behavior

The user reports that closing the first Dispatch agent closes its entire tab and that Close Old Agents kills running agents outside its intended selection. The existing root-pane path treats removing the sole grid leaf as a tab close, expanding an individual session into all detached siblings. Bulk cleanup asserts preConfirmed against a preview that never included those siblings. Existing issue #153 records the root-pane problem; a separate linked issue records the bulk-cleanup defect.

Manual closing of a root agent with other project sessions must offer Cancel, Close Agent, and Close Tab with clear impact. Choosing the agent preserves unrelated sessions and the project. Because Tab.root requires a leaf, promote a surviving detached session into the grid without restarting its backend. If no sessions remain, the empty project can disappear. Preserve meaningful Undo Close behavior.

Bulk cleanup may only close previewed sessions that remain eligible immediately before the destructive boundary. It must use session-only scope, never implicitly close a tab's other sessions, and never silently cascade into an unapproved linked child. Unknown activity is ineligible. Fresh work, prompt submission, semantic activity, and terminal activity must defeat old transcript timestamps. Count actual action outcomes, not attempted calls.

## Implementation sequence

1. Reproduce root/linked cascade expansion and activity-selection problems in deterministic tests using current action harnesses and modal tests.
2. Introduce explicit close scope and the root-agent/tab choice through the existing confirmation surface. Preserve project ownership by promoting a survivor; retain tab close and undo semantics.
3. Make bulk cleanup eligibility reusable, current at the action boundary, conservative with uncertain activity, and bounded to preview targets. Handle declined/skipped/failed closes honestly.
4. Exercise root choice, cancellation, tab close, linked agents, undo, bulk selection, fresh activity, running sessions, stale previews, and asynchronous ownership races.
5. Run focused tests, relevant type checks, the deterministic project gate, and review the diff. Commit implementation, open a complete PR linked to the issues, and report results without merging.

## Constraints

- Keep the original main checkout and its untracked takeover plan untouched.
- Work from current origin/main in fix/dispatch-agent-close-safety.
- Reuse the existing dialog primitive and its input/focus ownership.
- Preserve provider/runtime and renderer/main boundaries; do not exercise real session-kill APIs during verification.
- Add thick WHY comments for close scope, promotions, grant revalidation, and activity provenance.
- Do not broaden this work into unrelated Dispatch row-binding repairs (#863).

## Implementation and verification

- Manual root closure now uses the shared dialog to choose agent or tab scope. Agent scope promotes the next displayed detached row without restarting it; undo restores the root and row order unless a later layout edit takes precedence. Focused keyboard closes delegate to the same explicit-session action.
- Bulk cleanup keeps single-session scope, closes eligible linked descendants first, and skips any parent whose linked children remain. Eligibility is checked synchronously from current action refs immediately before requesting a kill. Workspace ownership refs now subscribe synchronously to Zustand alongside runtimes so sequential closes do not reuse stale layout ownership.
- Activity uses the newest transcript, submission, phase, turn, or semantic evidence; incomplete bootstrap history stays ineligible. Process/terminal activity counts as live. Cleanup reports actual closed, skipped, and failed results.
- Focused regression run: 39 tests passed across five files, including the real modal/action integration, dialog choices, root promotion/undo, and the actual controller ownership subscription. The root-scope regressions failed before implementation.
- Type checking and application build/package verification passed. The deterministic full gate passed 3,210 tests and failed one existing local image-fixture provenance check because its personal source transcript is missing. The failing file is unchanged; existing issue #684 documents this exact environment-dependent failure. The full gate stopped before packaging, so the package check was run separately and passed.
- All destructive APIs were mocked in verification; no live user sessions were closed. Issues #153 and #886 track the two reported defects.

## Review round 1 (2026-09-12)

Two independent reviews of `8d3a4018` (Codex: request changes, 1 blocker + 4 major; Claude: approve with comments). Branch merged with current main first. Decisions that shape the code, recorded here so the next round does not re-derive them:

- **Close is an explicit approved operation.** `closeSession` resolves every path (root dialog, ordinary gate, `silentIfSoleTarget`, bulk `preConfirmed`+`onlyIf`) to one approved snapshot list, then executes it through `closeApprovedTarget`. Linked children are no longer re-entered with a reusable `preConfirmed: true`; each member is re-judged synchronously at its own kill boundary (placed, same project, not newly working, caller predicate), children close first, and a parent is kept while any linked child still exists — refused, failed, never approved, or linked after the dialog. A buried linked child also keeps its parent (closeSession never kills buried sessions); that is conservative and stated in the WHY.
- **Promotion excludes the whole pending operation** and every member re-resolves placement from the live store at commit, so a cascade can never root a tab at a session it is about to delete. When a child's close empties a detached parent's project, the parent records a restorable tab entry instead of a stale detached one.
- **Close Tab executes the dialog's plan**, including linked descendants attached in other projects, deepest first with the root last; if a member changed or failed, the root promotes that survivor rather than deleting a nonempty project. Undo capture moved after the kill and describes what actually committed.
- **Undo lineage.** Every successful restore publishes old→new session and tab ids to the stack (`UndoCloseStack.remapLineage`), so close A / close B / undo / undo restores the original root and row order. Merge publishes nothing, so entries anchored on a merged-away tab stay stale (#914).
- **Dispatch focused close is strict:** an empty, dead or out-of-scope tiled lane closes nothing (no grid fallback).
- One tab-removal tail (`tabRemoval.ts`) for the Close Tab command and emptied-tab closes: previous-neighbour next tab, Dispatch cleanup, Tiled Tabs/Spotlight/Reader cleanup. The command previously activated the first tab.
- Automation: Agent Management no longer reports a sole grid leaf's siblings as affected; `silentIfSoleTarget` on such a root closes silently and promotes; `agents.close` and the operator guide name the Close Agent vs Close Tab choice.
- Declined here: unifying "last active" rules (#915 owns it; WHY added at `latestAgentActivityAt`); the #863 row-binding scrub (coordinator comments on #863).
