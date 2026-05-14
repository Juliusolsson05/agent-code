import type { EditorFileBuffer } from '@renderer/features/editor/types'
import { basename } from '@renderer/features/editor/lib/path'
import { FileIcon } from '@renderer/features/editor/lib/fileIcon'

type Props = {
  fileOrder: string[]
  openFiles: Record<string, EditorFileBuffer>
  activeFilePath: string | null
  onActivate: (path: string) => void
  onClose: (path: string) => void
}

export function EditorTabs({
  fileOrder,
  openFiles,
  activeFilePath,
  onActivate,
  onClose,
}: Props) {
  if (fileOrder.length === 0) {
    return (
      <div className="flex h-9 flex-shrink-0 items-center border-b border-border bg-surface px-3 font-code text-[11px] text-muted">
        No file open · pick one from the explorer
      </div>
    )
  }
  return (
    <div className="flex h-9 flex-shrink-0 items-stretch overflow-x-auto border-b border-border bg-surface font-code text-[11px]">
      {fileOrder.map(path => {
        const file = openFiles[path]
        if (!file) return null
        const active = path === activeFilePath
        const name = basename(path)
        return (
          // WHY the active tab paints with `bg-canvas`:
          //   the canvas color matches the Monaco editor surface below, so the
          //   active tab visually "merges" with the editor — a small cue that
          //   makes the tab strip feel attached to the editor instead of
          //   floating above it. The accent stripe at the top reinforces the
          //   selected state without recoloring the whole tab.
          <div
            key={path}
            className={`group relative flex min-w-[140px] max-w-[240px] items-stretch border-r border-border ${
              active ? 'bg-canvas text-ink' : 'bg-surface text-ink-dim hover:bg-surface-hi hover:text-ink'
            }`}
          >
            {active && (
              <span className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-accent" aria-hidden="true" />
            )}
            <button
              type="button"
              onClick={() => onActivate(path)}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 text-left"
              title={path}
            >
              <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                <FileIcon name={name} />
              </span>
              <span className="truncate">{name}</span>
              {file.dirty && (
                <span className="ml-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" aria-label="modified" />
              )}
            </button>
            <button
              type="button"
              onClick={event => {
                event.stopPropagation()
                onClose(path)
              }}
              aria-label={`Close ${name}`}
              className="flex w-7 flex-shrink-0 items-center justify-center text-[14px] leading-none text-muted opacity-60 hover:text-ink hover:opacity-100 group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
