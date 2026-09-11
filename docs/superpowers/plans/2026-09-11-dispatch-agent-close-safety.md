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
