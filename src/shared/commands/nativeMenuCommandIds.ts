/**
 * The command ids the macOS application menu dispatches over `menu:command`.
 *
 * WHY this is a shared constant instead of string literals inline in
 * `appMenu.ts`: the ids are a CONTRACT between two processes that cannot see
 * each other's code. Main emits a bare string; the renderer looks it up in its
 * command catalog. Nothing checked that the string on one side still names a
 * command on the other, so renaming or retiring a command silently produced a
 * menu item that does nothing — no error, no log, just a dead click.
 *
 * Exporting the list lets `catalog.test.ts` assert the subset relationship in
 * the renderer suite, where the catalog is importable. `appMenu.ts` itself
 * cannot be imported from a test without pulling in `electron`, so putting the
 * ids where BOTH sides can reach them is what makes the invariant testable at
 * all.
 *
 * This is characterization only: it records the six ids the menu dispatches
 * today. The governance plan's Phase 1 changes HOW they resolve (full catalog,
 * contextual admission, deliberately skipping picker visibility) — this
 * constant is what that resolution will be driven from.
 */
export const NATIVE_MENU_COMMAND_IDS = [
  'new-tab',
  'resume-session',
  'save-editor-file',
  'save-all-editor-files',
  'reorder-tabs',
  'close-tab',
] as const

export type NativeMenuCommandId = (typeof NATIVE_MENU_COMMAND_IDS)[number]
