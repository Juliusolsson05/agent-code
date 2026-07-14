import { memo } from 'react'

import type { Entry } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'

import { attachmentLabel } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { ExpandSection } from '@renderer/features/feed/ui/kit/ExpandSection'

// System-entry renderer — the hidden-by-default row that shows
// meta-entries from the transcript (permission-mode switches,
// file-history snapshots, hook attachments). These don't contribute
// to the conversation; they're diagnostic surfaces the user opts into
// via settings. Rendered muted with the `·` marker so when visible
// they're clearly secondary to real turns.
//
// Upgrade over the old one-line label: hook attachments carry a real
// payload (matched tool, hook output) that used to be unreachable —
// when a payload exists it sits behind a collapsed ExpandSection, so
// the row stays one muted line until deliberately opened.

const PAYLOAD_CAP = 8 * 1024

export const SystemRow = memo(function SystemRow({ entry }: { entry: Entry }) {
  const label =
    entry.type === 'attachment'
      ? attachmentLabel(entry)
      : entry.type === 'permission-mode'
        ? `permission mode: ${(entry as { permissionMode?: string }).permissionMode ?? '?'}`
        : entry.type === 'file-history-snapshot'
          ? 'file history snapshot'
          : entry.type

  const attachment = entry.type === 'attachment' ? asRecord(asRecord(entry)?.attachment) : null
  const payloadJson = (() => {
    if (!attachment) return null
    try {
      const json = JSON.stringify(attachment, null, 2)
      if (json === '{}') return null
      return json.length > PAYLOAD_CAP ? `${json.slice(0, PAYLOAD_CAP)}\n…` : json
    } catch {
      return null
    }
  })()

  return (
    <MarkerRow marker="·" tone="muted">
      <div className="text-[11px] text-muted leading-[1.65] opacity-60">
        {payloadJson ? (
          <ExpandSection summary={label}>
            <pre className="font-code text-[11px] leading-[1.5] whitespace-pre-wrap break-words m-0 max-h-[240px] overflow-auto">
              {payloadJson}
            </pre>
          </ExpandSection>
        ) : (
          label
        )}
      </div>
    </MarkerRow>
  )
})
