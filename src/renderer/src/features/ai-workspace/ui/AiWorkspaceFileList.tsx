import type { AiWorkspaceFileEntry } from '@mcp/shared/aiWorkspaceTypes'
import { FileIcon } from '@renderer/features/editor/lib/fileIcon'
import { basename } from '@renderer/features/editor/lib/path'

type AiWorkspaceFileListProps = {
  title: string
  entries: AiWorkspaceFileEntry[]
  loading: boolean
  error: string | null
  activeEntryId: string | null
  onOpenEntry: (entry: AiWorkspaceFileEntry) => void
  onRefresh: () => void
  onClose: () => void
}

function fileTitle(entry: AiWorkspaceFileEntry): string {
  return entry.title || basename(entry.path)
}

function workspaceLabel(entry: AiWorkspaceFileEntry): string {
  if (entry.gitBranch) return entry.gitBranch
  if (entry.projectRoot) return basename(entry.projectRoot)
  return basename(entry.path)
}

// Curated file-list adapter for AI Workspace.
//
// WHY this is not the same component as ExplorerPane: AI Workspace is a
// deliberately curated, multi-root list. There is no single directory to
// expand, and stale references are first-class evidence from an agent's review
// trail rather than nodes to hide. Sharing the surrounding workbench gives it
// the same tabs/editor/resizing behavior as Global Editor while this adapter
// preserves the multi-root semantics.
export function AiWorkspaceFileList({
  title,
  entries,
  loading,
  error,
  activeEntryId,
  onOpenEntry,
  onRefresh,
  onClose,
}: AiWorkspaceFileListProps) {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-surface font-code text-[12px]">
      <div className="flex h-8 flex-shrink-0 items-center justify-between gap-2 border-b border-border px-2 text-[10px] uppercase tracking-wider text-muted">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="text-muted hover:text-ink"
          >
            refresh
          </button>
          <button
            type="button"
            onClick={onClose}
            className="border border-border bg-surface-hi px-1.5 py-0.5 text-muted hover:border-accent hover:text-ink"
          >
            close
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {loading ? (
          <div className="px-2 py-1 text-muted">loading...</div>
        ) : error ? (
          <div className="px-2 py-1 text-danger">{error}</div>
        ) : entries.length === 0 ? (
          <div className="px-2 py-1 text-muted">No files attached.</div>
        ) : (
          entries.map(entry => {
            const stale = !entry.status.exists || !entry.status.readable
            return (
              <button
                key={entry.entryId}
                type="button"
                disabled={stale}
                onClick={() => onOpenEntry(entry)}
                className={`flex w-full items-start gap-2 px-2 py-1.5 text-left transition-colors ${
                  activeEntryId === entry.entryId
                    ? 'bg-accent-soft text-ink'
                    : stale
                      ? 'text-muted opacity-70'
                      : 'text-ink-dim hover:bg-surface-hi hover:text-ink'
                }`}
                title={entry.path}
              >
                <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
                  <FileIcon name={entry.path} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{fileTitle(entry)}</span>
                  <span className="block truncate text-[10px] text-muted">
                    {stale ? entry.status.staleReason ?? 'stale' : workspaceLabel(entry)}
                  </span>
                </span>
              </button>
            )
          })
        )}
      </div>
    </aside>
  )
}
