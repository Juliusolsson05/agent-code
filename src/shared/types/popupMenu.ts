/**
 * A native popup menu described as DATA (#1180).
 *
 * WHY data and not a main-side menu per feature: the browser pocket menu
 * (main/browserPocket/nativeMenus.ts) builds its template in main because main
 * owns what it acts on. The Sessions list menu is the opposite: every item is a
 * renderer command that needs the live CommandContext, so main can do nothing
 * with a choice except hand its id back. One generic channel serves this menu
 * and the follow-up surfaces (lane chips, the pane header) without new main
 * code per surface.
 *
 * Security shape: the renderer can only make main SHOW a menu and return one
 * of the ids it supplied. No roles (a `role: 'quit'` item would let a
 * compromised renderer quit the app through a click it staged), no callbacks,
 * no commands. `validatePopupMenu` in main enforces this rather than trusting
 * the type.
 */
export type PopupMenuItem =
  | {
      type: 'item'
      /** Returned verbatim when chosen. Opaque to main. */
      id: string
      label: string
      /** Default true. */
      enabled?: boolean
      /** Shows a check mark. A plain checkbox item, not a radio group:
       *  exclusivity is the renderer's business (the colour flag submenu has
       *  exactly one checked entry because the renderer made it so). */
      checked?: boolean
      /**
       * Electron accelerator string, DISPLAY ONLY (`toElectronAccelerator`).
       * Main passes `registerAccelerator: false`, so on Linux/Windows the item
       * does not claim the chord globally; on macOS a context menu never did.
       * The app's own keybinding router stays the only thing that runs chords.
       */
      accelerator?: string
    }
  | { type: 'separator' }
  | { type: 'submenu'; label: string; items: PopupMenuItem[] }

export type PopupMenuRequest = {
  items: PopupMenuItem[]
  /**
   * Where to open, in the sender window's content coordinates (CSS pixels,
   * which is what Electron's `popup({ x, y })` takes). Omitted = at the cursor,
   * which is right for a mouse right-click; a keyboard-opened menu passes the
   * focused row's corner so it does not appear wherever the mouse happens to
   * be resting.
   */
  x?: number
  y?: number
}

/** Hard bounds, shared so the renderer's builder can be tested against the
 *  same numbers main enforces. Generous for the Sessions menu (~20 items,
 *  one submenu of 9) while still refusing a runaway template. */
export const POPUP_MENU_MAX_ITEMS = 60
export const POPUP_MENU_MAX_DEPTH = 2
