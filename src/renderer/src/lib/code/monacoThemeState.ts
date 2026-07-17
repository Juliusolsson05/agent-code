// Shared ownership state for Monaco's GLOBAL theme.
//
// Monaco's setTheme is process-global, and two modules legitimately want
// to drive it:
//   - monacoRuntime.ts owns the code-slab themes used by transcript
//     CodeBlocks (and re-derives them from CSS custom properties when the
//     app theme changes);
//   - features/editor/lib/monacoEditorTheme.ts owns the editor-canvas
//     themes used while a file editor is mounted, refcounted so a future
//     split view works.
//
// Before this module existed the two fought: getMonaco() re-asserted the
// slab theme on EVERY call, so a transcript code block mounting while the
// Global Editor was open yanked the whole editor back onto the slab
// palette (#513). The fix is not to merge the modules (the renderer test
// suite pins the split contract: the editor module must never touch
// setTheme while inactive) but to give them one shared answer to "who
// owns the global theme right now".
//
// INVARIANT: monacoRuntime may only call setTheme when
// isEditorThemeActive() is false; monacoEditorTheme may only call it when
// it holds at least one acquisition (or is releasing the last one, at
// which point it restores the slab theme itself).
//
// WHY a module and not exports from either owner: lib/code must not
// import from features/* (layering), and features importing a mutable
// counter from monacoRuntime would tangle the lazy-load boundary. A
// dumb leaf module both can import keeps the dependency graph acyclic.

let editorThemeUsers = 0

export function editorThemeAcquired(): void {
  editorThemeUsers += 1
}

export function editorThemeReleased(): void {
  editorThemeUsers = Math.max(0, editorThemeUsers - 1)
}

export function isEditorThemeActive(): boolean {
  return editorThemeUsers > 0
}
