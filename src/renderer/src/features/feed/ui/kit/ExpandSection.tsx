import { useState, type ReactNode } from 'react'

// Lazy <details> — the kit-wide successor to ToolResultRow's private
// LazyDetails (ported from ToolResultRow.tsx:17-43 @269f9fc).
//
// WHY children gate on first-open: a closed <details> hides its
// contents visually but React still mounts them. The expensive child
// here is usually a Monaco CodeBlock — editor creation, model
// allocation, sometimes an LSP document lifecycle. Gating on
// first-open keeps dense restored feeds cheap until the user
// explicitly drills in. Once opened, children STAY mounted (collapse
// hides, doesn't unmount) so re-expanding is instant and any editor
// state survives.

export function ExpandSection({
  summary,
  defaultOpen = false,
  children,
}: {
  summary: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [everOpened, setEverOpened] = useState(defaultOpen)
  return (
    <details
      className="text-[12px] leading-[1.55] text-ink-dim"
      open={defaultOpen || undefined}
      onToggle={event => {
        if (event.currentTarget.open) setEverOpened(true)
      }}
    >
      <summary className="cursor-pointer select-none">{summary}</summary>
      {everOpened ? <div className="mt-2">{children}</div> : null}
    </details>
  )
}
