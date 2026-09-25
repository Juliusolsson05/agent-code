import { Button } from '@renderer/components/ui/button'

type Props = {
  message: string
  conflict: boolean
  externalChange: 'changed' | 'deleted' | null
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
// "Reload from Disk" (discard my edits, take the disk version) and
// "Overwrite" (my buffer wins, skip the mtime check once) — because a
// conflict is not resolvable by retrying; parking the actions anywhere
// less proximate (a toast, the command palette) leaves the user stuck
// staring at an error they can't act on.
// KEYBOARD / READABILITY (K2-6): the message WRAPS instead of truncating to
// one line with the full text only in a hover `title`. This banner is read
// immediately before a destructive choice (Reload discards the buffer,
// Overwrite discards the disk version), and a keyboard user could never see
// the clipped half of it. The wrap is capped at about four lines so a huge
// backend error cannot push the editor off screen; a capped message scrolls,
// and a scroller with no focusable content is itself a Tab stop in Chromium,
// so the overflow stays reachable by keyboard.
//
// role="alert", not aria-live="polite": the banner mounts together with its
// text, and a polite region that appears with its content is not announced.
// An alert is announced on insertion, which a save failure warrants.
export function EditorStatusBanner({
  message,
  conflict,
  externalChange,
  onReload,
  onOverwrite,
}: Props) {
  return (
    <div
      role="alert"
      className="flex flex-shrink-0 items-start gap-3 border-b border-border bg-danger-soft px-3 py-1.5 font-code text-[11px] text-danger"
    >
      <span className="max-h-[4.5rem] min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap leading-[1.5] [overflow-wrap:anywhere]">
        {message}
      </span>
      {conflict && externalChange !== 'deleted' && onReload && (
        <Button type="button" variant="outline" size="xs" onClick={onReload}>
          Reload from Disk
        </Button>
      )}
      {conflict && onOverwrite && (
        <Button type="button" variant="destructive-outline" size="xs" onClick={onOverwrite}>
          {externalChange === 'deleted' ? 'Recreate File' : 'Overwrite'}
        </Button>
      )}
    </div>
  )
}
