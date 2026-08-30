# UI containment and contextual radius fix

Issue: #680

## Outcome

Keep the shared debug/recording note prompt inside its declared viewport bound, and make the pane-local toast read as inline status chrome rather than a detached pill. Preserve the larger `float` radius for genuinely detached surfaces such as global toasts, dialogs, menus, and popovers.

## Why these changes belong together

Both defects surfaced in the first review of the semantic radius rollout, but they exercise different contracts that should stay explicit:

- A dialog declares a viewport-relative width, so every direct grid child must be allowed to shrink inside that width. Relying on a descendant's `w-full` is insufficient when an ancestor still participates in intrinsic grid sizing.
- Radius tokens describe placement, not just shape. `PaneToast` is embedded between pane regions and carries no shadow or scrim, so treating it as a detached `float` makes its small line box clamp into an almost fully rounded capsule.

## Implementation

1. Reproduce the note prompt with long unbroken metadata and inspect the dialog, body wrapper, and textarea width constraints at normal and narrow viewports.
2. Add the smallest shared dialog containment invariant that fixes every direct child without clipping legitimate dialog content. Add a feature-level constraint only if the shared invariant does not fully cover the note prompt.
3. Retoken `PaneToast` to the small interactive/chrome radius while leaving `GlobalToast` on `rounded-float`.
4. Add renderer tests that assert the shrink/containment class contract, distinguish inline from detached toast radii, and keep pathological feedback from growing tall enough to displace the pane composer.
5. Run focused renderer tests, the renderer suite, and typecheck. Visually compare the affected surfaces at narrow and normal widths using the available local Chromium/Electron path.

## Guardrails

- Do not add `overflow-hidden` to the dialog as a cosmetic mask: dialogs can legitimately contain popovers, focus rings, and other content that may paint beyond a child box.
- Do not change the numeric corner presets to repair one misclassified surface. The token value is shared; placement classification is the defect.
- Do not flatten `GlobalToast`: it is fixed, shadowed, and genuinely detached from the workspace grid.
- Do not solve horizontal containment by allowing an unbounded number of wrapped lines. Pane feedback may contain full paths and backend errors, so it needs both emergency word wrapping and a finite block-size contract.
