// App interaction ownership is a DOM contract, not a UI-store contract.
//
// WHY this deliberately uses one data attribute instead of deriving "is a
// modal open?" from uiShell booleans:
//
// Agent Code has app-blocking surfaces from several independent owners:
// uiShell modals, provider conditions rendered inside TileLeaf, setup gates,
// the image lightbox, and full-screen workspace takeovers. Duplicating every
// one of those states into a second modal manager would immediately create the
// same drift this rewrite is meant to remove. The mounted DOM is the only
// source of truth shared by all of them, including Radix portals.
//
// WHY this is NOT inferred from role="dialog": ARIA describes semantics for
// assistive technology. It must not secretly double as application routing
// state. The old composer guards did exactly that, so a visually modal surface
// that forgot its role leaked type/paste/Enter to an agent, while SettingsPage
// used the role partly to obtain internal behavior. Keeping the marker
// explicit lets accessibility and input ownership each be correct on their
// own terms.

export const APP_INTERACTION_OWNER_ATTRIBUTE = 'data-agent-code-interaction-owner'
export const APP_INTERACTION_OWNER_VALUE = 'app'
export const APP_INTERACTION_OWNER_SELECTOR =
  `[${APP_INTERACTION_OWNER_ATTRIBUTE}="${APP_INTERACTION_OWNER_VALUE}"]`

/**
 * Synchronous by design: DOM key handlers, native-menu IPC callbacks, and the
 * native dictation dispatcher must all make the same decision in the event
 * turn that delivered input. A React subscription/effect would leave a
 * one-render race where the surface is visible but background input is live.
 */
export function hasAppInteractionOwner(root?: ParentNode): boolean {
  const queryRoot = root ?? (typeof document === 'undefined' ? null : document)
  return queryRoot?.querySelector(APP_INTERACTION_OWNER_SELECTOR) != null
}

// PANE interaction ownership (#713). A pane-scoped condition dialog owns the
// keys aimed INSIDE it, and nothing else: the rest of the app stays live, so
// this cannot be the app marker above, which every global router treats as
// "stop". Routers ask about the EVENT TARGET, not about the document, because
// "is there a pane dialog somewhere" is exactly the app-wide blocking #713
// removes. See components/ui/pane-dialog.tsx.
export const PANE_INTERACTION_OWNER_ATTRIBUTE = 'data-agent-code-pane-interaction-owner'

/** True when `target` sits inside a pane-scoped dialog, whose own element
 *  handlers own the key or paste. */
export function isInPaneInteractionOwner(target: EventTarget | null): boolean {
  return typeof Element !== 'undefined'
    && target instanceof Element
    && target.closest(`[${PANE_INTERACTION_OWNER_ATTRIBUTE}]`) != null
}

/**
 * True when the pane holding `inside` (its `[data-pane-id]` root) currently
 * shows a pane-scoped dialog. Pane-local routers that write into the COMPOSER
 * ask this: the composer sits under that dialog's scrim, so a key or paste
 * redirected into it would edit a draft the user cannot see, past a prompt
 * waiting for an answer.
 */
export function paneHasInteractionOwner(inside: Element | null | undefined): boolean {
  const pane = inside?.closest('[data-pane-id]')
  return pane?.querySelector(`[${PANE_INTERACTION_OWNER_ATTRIBUTE}]`) != null
}
