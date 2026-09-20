import { useEffect, useRef } from 'react'

import type { RemoteNoteRecord } from '../../wire'
import { relativeShort } from './time'

// The phone's TLDR/Goal peek — the Cmd+L/Cmd+G glance brought to touch.
//
// CONTRACT (mirrors the desktop TldrOverlay/TldrFreshness pair so the two
// devices present the SAME information with the same words):
//   - an opaque canvas overlay, not a dimming scrim — the pane's text must
//     not bleed through a status the user is trying to read;
//   - centered whitespace-pre-wrap record text, or the honest fallbacks
//     ("No TLDR yet" / "TLDR unavailable") — never a spinner;
//   - a muted footer row: `Last active <relative>` from the session's live
//     activity, and `Note written`/`Goal set <relative>` from the record's
//     own updatedAt — the freshness pair that makes a stale status
//     self-evident;
//   - a toggle chip switching TLDR <-> Goal instead of closing (the
//     desktop's latch toggle, one glance gesture for both records).
//
// Gesture adaptation for touch: the desktop holds a key; the phone holds a
// ROW (FleetHome) or taps a header button (SessionScreen). Release-to-
// dismiss belongs to the hold gesture and lives there; this overlay closes
// on its own tap-anywhere, which is the touch idiom for "peek done".

export type PeekKind = 'tldr' | 'goal'

export function PeekOverlay({
  kind,
  record,
  lastActiveAt,
  onDismiss,
  onToggleKind,
}: {
  kind: PeekKind
  record: RemoteNoteRecord | null
  /** Epoch ms of the session's last observed activity (Last active footer). */
  lastActiveAt: number | null
  onDismiss: () => void
  onToggleKind: () => void
}): React.JSX.Element {
  // Escape closes (external keyboards), same as the desktop's input gate.
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  const label = kind === 'tldr' ? 'TLDR' : 'Goal'
  const writtenLabel = kind === 'tldr' ? 'Note written' : 'Goal set'
  const body = record?.text?.trim()
    ? record.text
    : kind === 'tldr'
      ? 'No TLDR yet'
      : 'No goal set yet'

  return (
    <div
      ref={ref}
      // data hooks mirror the desktop overlays so shape-recording tooling
      // and tests can find the surface identically on either device.
      data-tldr-overlay={kind === 'tldr' || undefined}
      data-goal-overlay={kind === 'goal' || undefined}
      role="note"
      aria-label={`${label} peek`}
      onClick={onDismiss}
      className="peek-overlay"
    >
      <p className="peek-body">{body}</p>
      <div className="peek-footer">
        <span>Last active {lastActiveAt ? relativeShort(lastActiveAt) : 'unknown'}</span>
        <span>
          {writtenLabel} {record ? relativeShort(Date.parse(record.updatedAt)) : '—'}
        </span>
        <button
          type="button"
          // Stop propagation: the chip toggles the record kind, it does not
          // dismiss — tapping anywhere ELSE does.
          onClick={e => {
            e.stopPropagation()
            onToggleKind()
          }}
          className="peek-toggle"
        >
          {kind === 'tldr' ? 'show goal' : 'show tldr'}
        </button>
      </div>
    </div>
  )
}
