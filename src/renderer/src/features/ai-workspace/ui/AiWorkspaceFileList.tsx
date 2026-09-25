import { EmptyState } from '@renderer/components/ui/empty-state'
import { useState } from 'react'
import { Alert } from '@renderer/components/ui/alert'

import { Button } from '@renderer/components/ui/button'
import { PanelHeader } from '@renderer/components/ui/panel-header'

import type { AiWorkspaceFileEntry } from '@mcp/shared/aiWorkspaceTypes'
import { FileIcon } from '@renderer/features/editor/lib/fileIcon'
import { basename } from '@renderer/features/editor/lib/path'
import { withVisibleControls } from '@shared/text/visibleControls'

type AiWorkspaceFileListProps = {
  title: string
  entries: AiWorkspaceFileEntry[]
  loading: boolean
  error: string | null
  activeEntryId: string | null
  onOpenEntry: (entry: AiWorkspaceFileEntry) => void
  onRefresh: () => void
  onClose: () => void
  onDetachEntry: (entry: AiWorkspaceFileEntry) => void
  onDeleteWorkspace: () => void
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
  onDetachEntry,
  onDeleteWorkspace,
}: AiWorkspaceFileListProps) {
  const [deleteArmed, setDeleteArmed] = useState(false)
  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-surface font-code text-[12px]">
      {/* The shared side-panel header (UI pass, G-26). The title is
          model-authored, and the two-click Delete acts on it (#1049
          re-review), so it stays visible as the header's second line. */}
      <PanelHeader
        label="AI Workspace"
        title={withVisibleControls(title)}
        onClose={onClose}
        closeLabel="Close AI Workspace"
        actions={
          <>
            <Button type="button" variant="ghost" size="xs" aria-label="Refresh AI Workspace files" onClick={onRefresh}>
              Refresh
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={deleteArmed ? 'Confirm delete AI Workspace' : 'Delete AI Workspace'}
              title="Delete AI Workspace metadata (files stay on disk)"
              onClick={() => {
                if (deleteArmed) onDeleteWorkspace()
                else setDeleteArmed(true)
              }}
              onBlur={() => setDeleteArmed(false)}
              className={deleteArmed ? 'text-danger' : 'hover:text-danger'}
            >
              {deleteArmed ? 'Confirm Delete' : 'Delete'}
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error ? (
          <Alert className="mx-2 mb-1">{error}</Alert>
        ) : null}
        {loading ? (
          <div role="status" aria-live="polite" className="px-2 py-1 text-muted">
            Loading AI Workspace…
          </div>
        ) : entries.length === 0 ? (
          <EmptyState size="inline" className="px-2 py-1">No files attached.</EmptyState>
        ) : (
          entries.map(entry => {
            const stale = !entry.status.exists || !entry.status.readable
            const provenance = [
              entry.sourceAgentLabel,
              entry.taskId ? `task ${entry.taskId}` : null,
            ]
              .filter(Boolean)
              .join(' · ')
            const details = [entry.description, provenance].filter(Boolean).join(' · ')
            const staleReason = entry.status.staleReason ?? 'File is unavailable'
            return (
              <div
                key={entry.entryId}
                className={`group flex items-stretch ${
                  activeEntryId === entry.entryId
                    ? 'bg-accent-soft text-ink'
                    : stale
                      ? 'text-muted opacity-70'
                      : 'text-ink-dim hover:bg-row-hover-bg hover:text-ink'
                }`}
              >
                <button
                  type="button"
                  aria-current={activeEntryId === entry.entryId ? 'page' : undefined}
                  disabled={stale}
                  onClick={() => onOpenEntry(entry)}
                  className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed"
                  // Path, provenance and staleness are what distinguish two
                  // attachments with the same ordinary title — and the ×
                  // beside them detaches immediately, with no confirmation
                  // (#1049 re-review).
                  title={withVisibleControls([entry.path, stale ? staleReason : null, details || null]
                    .filter(Boolean)
                    .join('\n'))}
                >
                  <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
                    <FileIcon name={entry.path} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{withVisibleControls(fileTitle(entry))}</span>
                    <span className="block truncate text-[10px] text-muted">
                      {withVisibleControls(stale ? staleReason : workspaceLabel(entry))}
                    </span>
                    {details ? (
                      <span className="block truncate text-[10px] text-muted/80">{withVisibleControls(details)}</span>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onDetachEntry(entry)}
                  aria-label={`Remove ${fileTitle(entry)} from AI Workspace`}
                  title="Remove from AI Workspace (file stays on disk)"
                  className="w-7 flex-shrink-0 text-muted opacity-0 hover:text-danger focus:opacity-100 group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
