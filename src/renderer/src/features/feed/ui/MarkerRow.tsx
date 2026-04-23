import type { ReactNode } from 'react'

/**
 * The core layout for a feed row: a fixed-width marker column + flex-1
 * content column that enforces hanging indent. Used by every rendered
 * block (`⏺` for assistant text, `❯` for user prompts, `⎿` for tool
 * results / nested content).
 *
 * Because the marker column is a fixed width and the content column
 * is flex-1, long lines wrap under the content column only — they
 * don't creep back under the marker. Standard hanging-indent pattern.
 *
 * Exported because the git custom renderers (features/git/ui/GitRows)
 * also want the same marker+hanging-indent layout when they render
 * git-tool widgets in the feed.
 */
export function MarkerRow({
  marker,
  tone = 'accent',
  children,
  indent = 0,
}: {
  marker: string
  tone?: 'accent' | 'muted' | 'ink'
  children: ReactNode
  indent?: number
}) {
  const toneClass =
    tone === 'accent' ? 'text-accent' : tone === 'muted' ? 'text-muted' : 'text-ink-dim'
  return (
    <div
      className="flex gap-2.5"
      style={indent ? { paddingLeft: `${indent * 22}px` } : undefined}
    >
      <span
        className={`${toneClass} flex-shrink-0 w-3 text-[13px] leading-[1.65] select-none`}
        aria-hidden="true"
      >
        {marker}
      </span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
