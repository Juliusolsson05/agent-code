type Props = {
  message: string
  conflict: boolean
  onReload?: () => void
  onOverwrite?: () => void
}

// Save/stale errors render ABOVE the editor, never instead of it. The
// previous behavior (error replaced the whole Monaco pane via
// MonacoFileEditor's early return) meant a failed save hid the user's
// unsaved text at the exact moment they most need to see it, and made
// the dirty tab uncloseable with no visible path out (#513 bug 1).
//
// The conflict variant carries its two recovery actions inline —
// "Reload from disk" (discard my edits, take the disk version) and
// "Overwrite" (my buffer wins, skip the mtime check once) — because a
// conflict is not resolvable by retrying; parking the actions anywhere
// less proximate (a toast, the command palette) leaves the user stuck
// staring at an error they can't act on.
export function EditorStatusBanner({ message, conflict, onReload, onOverwrite }: Props) {
  return (
    <div className="flex flex-shrink-0 items-center gap-3 border-b border-border bg-danger/10 px-3 py-1.5 font-code text-[11px] text-danger">
      <span className="min-w-0 flex-1 truncate" title={message}>
        {message}
      </span>
      {conflict && onReload && (
        <button
          type="button"
          onClick={onReload}
          className="flex-shrink-0 rounded border border-border px-2 py-0.5 text-ink-dim hover:text-ink"
        >
          Reload from disk
        </button>
      )}
      {conflict && onOverwrite && (
        <button
          type="button"
          onClick={onOverwrite}
          className="flex-shrink-0 rounded border border-border px-2 py-0.5 text-ink-dim hover:text-ink"
        >
          Overwrite
        </button>
      )}
    </div>
  )
}
