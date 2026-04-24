import { shortenCwd } from '@renderer/workspace/tile-tree/TileLeaf/labels'

// Pane header: compact status strip.
//
// In status mode, working panes paint with the theme accent;
// idle/exited panes get no fill — the absence of color is the
// signal, so a glance across the grid highlights only the
// panes that still want attention. Previous design used
// green/red, but red read as "error" for merely idle panes.
export function PaneHeader({
  paneLabel,
  projectDir,
  statusMode,
  isSessionLive,
}: {
  paneLabel?: string
  projectDir: string | null
  statusMode: boolean
  isSessionLive: boolean
}) {
  return (
    <div
      className={`flex items-center justify-between px-3 border-b border-border text-[10px] font-code select-none ${
        statusMode
          ? isSessionLive
            ? 'bg-accent text-accent-fg'
            : 'bg-surface text-muted'
          : 'bg-surface text-muted'
      } ${statusMode ? 'py-0 min-h-[5px]' : 'py-1'}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {paneLabel && (
          <span className="flex-shrink-0 rounded-[3px] border border-current/30 px-1 leading-[14px] text-[9px] font-semibold tabular-nums">
            {paneLabel}
          </span>
        )}
        <span className="truncate" title={projectDir ?? 'no project dir'}>
          {shortenCwd(projectDir)}
        </span>
      </div>
    </div>
  )
}
