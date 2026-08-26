# Recent workflow selector plan

## Outcome

Keep the session-view selector below the composer bounded to the three most recently discovered
workflow lineages. Main remains permanently available, and the existing oldest-to-newest order is
preserved within the visible three-run window.

## Implementation

1. Apply the limit after transcript, transport, replacement, and resume-lineage reconciliation in
   `useSessionWorkflowViews`. This keeps every discovery source under the same rule and ensures the
   selected reference comes from the same bounded collection the selector renders.
2. Preserve the hook's existing missing-selection fallback. If a fourth run pushes the selected
   oldest run outside the visible window, the viewport returns to Main instead of displaying a
   workflow with no corresponding selected tab.
3. Add a focused model regression with five ordered run references. Assert that only the final
   three references survive in chronological order and that selection returns to Main when the
   oldest visible run ages out. Keep the existing selector regression proving Main remains present.

## Verification

- Focused workflow selector/model renderer tests.
- Renderer typecheck and the repository's package/contract gate as practical for this UI-only diff.
