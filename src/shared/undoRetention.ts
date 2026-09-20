/**
 * How long a closed session stays restorable by Undo Close.
 *
 * WHY THIS LIVES IN `shared/` RATHER THAN BESIDE THE UNDO STACK:
 * two processes have to agree on it, and they used to agree by accident.
 *
 * Closing a tmux-backed terminal detaches its attach-PTY but deliberately
 * leaves the tmux session running, so that Undo Close can re-attach the SAME
 * shell with its scrollback intact (`sessionManager.killOwnedInternal`,
 * `undoClose.ts`'s `recoverTmuxName`). That is the only reason the shell is
 * kept alive — once the entry that names it has expired off the renderer's
 * stack, nothing can ever reach it again, and main is the only side that can
 * reap it (`detachedSweep.ts`).
 *
 * So main's reap deadline is DERIVED from this window: reap earlier and Undo
 * Close restores a pane whose shell is already dead; reap never and every
 * closed terminal's shell survives until the next launch's startup reconcile,
 * which on a machine that stays awake for days is a real pile of idle
 * processes. Two copies of the number would drift, and the failure would be
 * silent in both directions.
 */
export const UNDO_CLOSE_RETENTION_MS = 60 * 60 * 1000 // 1 hour
