/**
 * The app's stacking layers, lowest first, as LITERAL Tailwind classes (#512).
 *
 * WHY literal class strings and not numbers: Tailwind only emits a class it
 * can see spelled out in source, so `z-[${n}]` built at runtime would silently
 * produce no CSS. This table is where the classes are spelled, and callers
 * reference them by name.
 *
 * WHY one table: the bands below were real but written as magic numbers in
 * about ten files, each with its own comment explaining why it sits above or
 * below some other number. The ordering is the contract, so it lives in one
 * place where a new surface picks a NAME and cannot land between two bands
 * by accident.
 *
 * Two scopes, which do not compare with each other:
 *   PANE: inside one pane's root (`position: relative`). A pane layer only
 *     orders things within that pane.
 *   APP: fixed to the window, above every pane.
 * Portaled Radix content (dialogs, menus) and the toast are APP layers.
 */
export const LAYERS = {
  // ---- PANE scope -------------------------------------------------------
  /** Pane overlays that leave the pane usable around them: the new-agent
   *  placement scrim, the goal-loop strip, the browser-pocket details. */
  paneOverlay: 'z-40',
  /** Full-pane takeovers (TLDR overlay, goal-loop pane) above those. */
  paneTakeover: 'z-50',
  /** Pane dialogs (pane-dialog.tsx): scrim covers the pane including its
   *  composer; content is the dialog; feedback is the pane's own status
   *  toast, which must stay readable above the scrim (#713). */
  paneDialogScrim: 'z-[60]',
  paneDialogContent: 'z-[61]',
  paneDialogFeedback: 'z-[62]',

  // ---- Inside a floating surface ---------------------------------------
  /** A popover inside a dialog or another surface (the palette's sort menu,
   *  the path field's suggestions). The dialog is its stacking context, so
   *  this only has to beat the dialog's own content. */
  inSurfacePopover: 'z-50',

  // ---- APP scope --------------------------------------------------------
  /** Every modal dialog: the shared Radix Dialog's scrim and content. */
  dialog: 'z-[1100]',
  /** Menus, which must paint above any dialog they open from (the Skills
   *  menu inside Settings). Portaled content at the dialog's own z would
   *  order by DOM position, which only works by accident. */
  menu: 'z-[1150]',
  /** Transient feedback above everything interactive: the toast, and the
   *  dictation chip (dictating into a dialog must stay visible). A toast
   *  under the dialog scrim was washed out to invisibility. */
  toast: 'z-[1200]',
  /** Developer debug overlays only (the rendering inspector's highlight). */
  debugOverlay: 'z-[10000]',
} as const
