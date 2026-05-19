import type { ReactNode } from 'react'

import type { EditorFileBuffer } from '@renderer/features/editor/types'
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
  onCloseFile: (path: string) => void
  onChangeFile: (path: string, text: string) => void
  onSave: () => void
  onSelectionRevealed?: (path: string) => void
}

// Shared editor workbench shell.
//
// WHY this owns only layout, not file loading: Global Editor and AI Workspace
// both look like "file source + tabs + Monaco", but their trust boundaries are
// different. Global Editor is rooted in one cwd and must go through
// editor-fs's root containment checks. AI Workspace is intentionally curated
// from absolute files across worktrees and goes through the AI Workspace
// registry. Forcing both through one filesystem API would either weaken
// containment or break the multi-root review workflow. This component shares
// the visual/editor mechanics while each surface keeps its own adapter.
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
  onSelectionRevealed,
}: EditorWorkbenchProps) {
  return (
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
      <ResizableSidebar
        visible={sidebarVisible}
        widthPx={sidebarWidthPx}
        onWidthChange={onSidebarWidthChange}
      >
        {sidebar}
      </ResizableSidebar>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <EditorTabs
          fileOrder={fileOrder}
          openFiles={openFiles}
          activeFilePath={activeFilePath}
          onActivate={onActivateFile}
          onClose={onCloseFile}
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <MonacoFileEditor
            file={activeFile}
            projectRoot={projectRoot}
            onChange={onChangeFile}
            onSave={onSave}
            onSelectionRevealed={onSelectionRevealed}
          />
        </div>
      </div>
    </div>
  )
}
