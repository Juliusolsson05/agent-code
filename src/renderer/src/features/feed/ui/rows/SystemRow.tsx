import { memo } from 'react'

import type { Entry } from '@shared/types/transcript'

import { attachmentLabel } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

// System-entry renderer — the hidden-by-default row that shows
// meta-entries from the transcript (permission-mode switches,
// file-history snapshots, hook attachments). These don't
// contribute to the conversation; they're diagnostic surfaces the
// user opts into via settings. Rendered muted with the `·` marker
// so when visible they're clearly secondary to real turns.
export const SystemRow = memo(function SystemRow({ entry }: { entry: Entry }) {
  const label =
    entry.type === 'attachment'
      ? attachmentLabel(entry)
      : entry.type === 'permission-mode'
        ? `permission mode: ${(entry as { permissionMode?: string }).permissionMode ?? '?'}`
        : entry.type === 'file-history-snapshot'
          ? 'file history snapshot'
          : entry.type
  return (
    <MarkerRow marker="·" tone="muted">
      <div className="text-[11px] text-muted leading-[1.65] opacity-60">
        {label}
      </div>
    </MarkerRow>
  )
})
