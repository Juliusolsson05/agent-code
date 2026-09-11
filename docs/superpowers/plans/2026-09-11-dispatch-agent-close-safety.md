# Dispatch agent close safety

Status: implementation planned.

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
