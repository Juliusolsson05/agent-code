import { useState, type ReactNode } from 'react'

import type { EditorFileBuffer } from '@renderer/features/editor/types'
import { basename } from '@renderer/features/editor/lib/path'
import { ConfirmCloseDialog } from '@renderer/features/editor/ui/ConfirmCloseDialog'
import { EditorStatusBanner } from '@renderer/features/editor/ui/EditorStatusBanner'
import { EditorTabs } from '@renderer/features/editor/ui/EditorTabs'
import { MonacoFileEditor } from '@renderer/features/editor/ui/MonacoFileEditor'
import { ResizableSidebar } from '@renderer/features/editor/ui/ResizableSidebar'

type EditorWorkbenchProps = {
  sidebar: ReactNode
  sidebarVisible?: boolean
  sidebarWidthPx: number
  onSidebarWidthChange: (widthPx: number) => void
  fileOrder: string[]
  openFiles: Record<string, EditorFileBuffer>
  activeFilePath: string | null
  activeFile: EditorFileBuffer | null
  projectRoot: string | null
  onActivateFile: (path: string) => void
  /** Close a tab. Returns false when the buffer is dirty and the close
   *  was refused — the workbench then owns showing ConfirmCloseDialog and
   *  re-calling with `{ force: true }` on Discard. Hosts implement force
   *  semantics against their own store (Global Editor zustand / AI
   *  Workspace local state). */
  onCloseFile: (path: string, opts?: { force?: boolean }) => boolean
  onChangeFile: (path: string, text: string) => void
  onSave: () => void
  /** Save the given file, then close it on success. Returns whether the
   *  save succeeded. Used by the dialog's "Save & Close"; when the host
   *  doesn't provide it the dialog falls back to a plain (refusable)
   *  close so the user still isn't stuck. */
  onSaveThenClose?: (path: string) => Promise<boolean>
  /** Conflict-banner actions — absent on hosts whose IO layer can't
   *  express them (the banner then shows the message only). */
  onReloadFromDisk?: (path: string) => void
  onOverwriteDisk?: (path: string) => void
  onSelectionRevealed?: (path: string) => void
}

// Shared editor workbench shell.
//
// WHY this owns only layout + close/error CHROME, not file loading:
// Global Editor and AI Workspace both look like "file source + tabs +
// Monaco", but their trust boundaries are different. Global Editor is
// rooted in one cwd and must go through editor-fs's root containment
// checks. AI Workspace is intentionally curated from absolute files
// across worktrees and goes through the AI Workspace registry. Forcing
// both through one filesystem API would either weaken containment or
// break the multi-root review workflow. This component shares the
// visual/editor mechanics — including the dirty-close confirm dialog and
// the save-error banner, which both surfaces used to get wrong
// independently — while each surface keeps its own IO adapter.
export function EditorWorkbench({
  sidebar,
  sidebarVisible = true,
  sidebarWidthPx,
  onSidebarWidthChange,
  fileOrder,
  openFiles,
  activeFilePath,
  activeFile,
  projectRoot,
  onActivateFile,
  onCloseFile,
  onChangeFile,
  onSave,
  onSaveThenClose,
  onReloadFromDisk,
  onOverwriteDisk,
  onSelectionRevealed,
}: EditorWorkbenchProps) {
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null)

  const requestClose = (path: string) => {
    const closed = onCloseFile(path)
    if (!closed) setPendingClosePath(path)
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
      <ResizableSidebar
        visible={sidebarVisible}
        widthPx={sidebarWidthPx}
        onWidthChange={onSidebarWidthChange}
      >
        {sidebar}
      </ResizableSidebar>
      {/* `relative` so ConfirmCloseDialog's absolute scrim covers exactly
          the tabs+editor column — see the dialog's WHY on scoping. */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <EditorTabs
          fileOrder={fileOrder}
          openFiles={openFiles}
          activeFilePath={activeFilePath}
          onActivate={onActivateFile}
          onClose={requestClose}
        />
        {activeFile?.error && activeFilePath && (
          <EditorStatusBanner
            message={activeFile.error}
            conflict={activeFile.conflict}
            onReload={
              onReloadFromDisk ? () => onReloadFromDisk(activeFilePath) : undefined
            }
            onOverwrite={
              onOverwriteDisk ? () => onOverwriteDisk(activeFilePath) : undefined
            }
          />
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <MonacoFileEditor
            file={activeFile}
            projectRoot={projectRoot}
            onChange={onChangeFile}
            onSave={onSave}
            onSelectionRevealed={onSelectionRevealed}
          />
        </div>
        {pendingClosePath && (
          <ConfirmCloseDialog
            fileName={basename(pendingClosePath)}
            onCancel={() => setPendingClosePath(null)}
            onDiscard={() => {
              onCloseFile(pendingClosePath, { force: true })
              setPendingClosePath(null)
            }}
            onSaveAndClose={() => {
              void (async () => {
                const saved = onSaveThenClose
                  ? await onSaveThenClose(pendingClosePath)
                  : false
                // On save failure the buffer error/banner explains why;
                // attempt a plain close anyway (no-ops while dirty) and
                // drop the dialog so the banner is visible.
                if (!saved) onCloseFile(pendingClosePath)
                setPendingClosePath(null)
              })()
            }}
          />
        )}
      </div>
    </div>
  )
}
