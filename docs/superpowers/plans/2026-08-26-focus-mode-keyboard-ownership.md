# Focus-mode keyboard ownership

> Status: planned for Issue #647.

## Goal

Make Reader Mode and Spotlight own keyboard interaction while they replace the
workspace surface. Navigating Reader history must not move a hidden Grid pane,
classic Dispatch row, or Tiled Dispatch lane, and Spotlight input must not
mutate workspace focus that the user cannot see.

## Confirmed cause

`ReaderView` and `useKeybinds` both install capture-phase `keydown` listeners
on `document`. Reader handles Option/Alt+ArrowUp and Option/Alt+ArrowDown as
older/newer assistant-message navigation. The workspace router handles the same
physical keys as Grid navigation or Dispatch selection.

Reader calls `preventDefault()`, but that only suppresses the browser default;
it does not prevent another listener on the same document from running. The
workspace router neither checks `defaultPrevented` nor recognizes Reader or
Spotlight as owning the interaction, so both actions execute.

`MainSurface` intentionally preserves the underlying workspace mode while a
focus takeover renders. When Reader or Spotlight closes, `DispatchAgentList`
remounts and scrolls its active row into view, exposing the hidden selection
change as an apparently displaced list.

## Invariants

1. Reader's Option/Alt+ArrowUp and Option/Alt+ArrowDown change only Reader's
   selected assistant message.
2. Spotlight does not permit navigation keys to mutate hidden Grid or Dispatch
   focus.
3. Classic Dispatch focus, every Tiled Dispatch lane selection, and Grid focus
   remain unchanged across a focus-mode keyboard interaction.
4. Escape and the active focus mode's own configured toggle chord still close
   that mode.
5. An app-owned modal opened above Reader or Spotlight keeps higher priority;
   Reader's document listener must not process history keys through that modal.
6. Explicit session selection inside Reader/Spotlight retains its existing
   behavior. This fix isolates incidental keyboard leakage; it does not sever
   the deliberate session-switching path.

## Design

Add one focus-takeover ownership gate to `useKeybinds` after its existing
Escape handling and before configured workspace commands, numbered navigation,
and bespoke Dispatch movement.

The gate will admit only the global command that owns the currently visible
focus mode (`toggle-reader-mode` for Reader, `toggle-spotlight` for Spotlight).
Every other workspace route returns without mutation. Agent Code-owned chords
still call `preventDefault()` so browser/Electron behavior cannot fire behind
the takeover, but the gate must not stop propagation: Reader's local document
listener still needs to receive its older/newer keys.

WHY this belongs in the central router instead of relying on
`stopPropagation()`: both listeners live on the same document, so propagation
order is not a durable ownership contract. The central router is the only
place that can guarantee no configured Grid command and no hard-coded Dispatch
grammar runs while the workspace is hidden.

Reader's local history listener will also yield whenever the DOM reports an
app interaction owner. Reader/Spotlight are inline focus surfaces rather than
Radix dialogs, but a modal can be opened above them; in that case the existing
DOM ownership contract, not listener registration order, decides who receives
the interaction.

Keep this change scoped to keyboard admission. Do not clear `dispatchMode`,
rewrite focus persistence, or make focus modes modal dialogs merely to obtain
the guard; those changes would alter product state and visual/accessibility
semantics rather than fix the routing defect.

## Regression coverage

Add renderer-level keyboard contracts that exercise the real document event
path and assert observable workspace calls:

1. Reader over classic Dispatch: Option/Alt+ArrowUp does not call
   `focusDispatchSession`.
2. Reader over Grid: the same event does not invoke `navigate` through a
   configured Grid binding.
3. Reader over Tiled Dispatch: the event does not change a lane selection.
4. Spotlight over Dispatch and Grid: directional shortcuts leave hidden focus
   untouched.
5. Escape and the active focus-mode toggle remain admitted.
6. Reader history still moves older/newer, and an app interaction owner above
   Reader suppresses that local movement.

Prefer a small hook/component harness around the real `useKeybinds` and
`ReaderView` behavior over assertions that merely restate a new predicate.

## Delivery steps

1. Add the failing renderer regression for Reader over Dispatch and confirm the
   hidden focus call occurs on current `main` behavior.
2. Add the central focus-takeover ownership gate with thick WHY comments.
3. Extend coverage to Grid, Tiled Dispatch, Spotlight, dismissal, and modal
   priority.
4. Run the focused renderer tests, keybinding contract, typecheck, full test
   suite, and package/build verification required by the repository gate.
5. Review the final diff for unrelated changes, update Issue #647 with any
   scope discoveries, push the branch, and open a PR using `Fixes #647`.

## Out of scope

- Changing Reader message extraction, scrolling, or provider rendering.
- Changing Dispatch ordering or its active-row scroll behavior.
- Clearing or rebuilding workspace focus state when entering a focus mode.
- Redesigning the general floating-surface system tracked by Issue #512.
- Merging the pull request.

