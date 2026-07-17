import { useEffect, useMemo, useRef, type ReactNode } from 'react'

import type { EditorFileBuffer } from '@renderer/features/editor/types'
import { basename } from '@renderer/features/editor/lib/path'
import { FileIcon } from '@renderer/features/editor/lib/fileIcon'

type Props = {
  fileOrder: string[]
  openFiles: Record<string, EditorFileBuffer>
  activeFilePath: string | null
  onActivate: (path: string, options: { focusEditor: boolean }) => void
  onClose: (path: string) => void
  onSave: () => void
  onSaveAll: () => void
  saveDisabled: boolean
  saveAllDisabled: boolean
  saveAllPending: boolean
  displayNameForPath?: (path: string) => string
  titleForPath?: (path: string) => string
  actions?: ReactNode
}

export function EditorTabs({
  fileOrder,
  openFiles,
  activeFilePath,
  onActivate,
  onClose,
  onSave,
  onSaveAll,
  saveDisabled,
  saveAllDisabled,
  saveAllPending,
  displayNameForPath = basename,
  titleForPath,
  actions,
}: Props) {
  const activeTabRef = useRef<HTMLButtonElement | null>(null)
  const tabNames = useMemo(() => {
    const names = new Map(fileOrder.map(path => [path, displayNameForPath(path)]))
    const pathsByName = new Map<string, string[]>()
    for (const [path, name] of names) {
      pathsByName.set(name, [...(pathsByName.get(name) ?? []), path])
    }
    for (const duplicatePaths of pathsByName.values()) {
      if (duplicatePaths.length < 2) continue
      const segmentsByPath = new Map(
        duplicatePaths.map(path => [
          path,
          (openFiles[path]?.absolutePath ?? path).split(/[\\/]/).filter(Boolean),
        ]),
      )
      for (const path of duplicatePaths) {
        const segments = segmentsByPath.get(path) ?? []
        const originalName = names.get(path) ?? displayNameForPath(path)
        const nameIsPhysicalBasename = segments.at(-1) === originalName
        // WHY only duplicate labels gain a parent suffix: showing full relative
        // paths all the time makes tabs noisy, while bare `index.ts` labels are
        // unusable as soon as two feature folders are open. The shortest unique
        // suffix preserves the compact common case and adds exactly the context
        // needed to choose the right duplicate.
        for (let depth = nameIsPhysicalBasename ? 2 : 1; depth <= segments.length; depth += 1) {
          const suffix = segments.slice(-depth).join('/')
          const unique = duplicatePaths.every(otherPath => {
            if (otherPath === path) return true
            return (segmentsByPath.get(otherPath) ?? []).slice(-depth).join('/') !== suffix
          })
          if (unique) {
            // Curated AI Workspace titles are meaningful labels, not filenames.
            // Retain them and append physical context; project tabs whose label
            // already is the filename read more naturally as `parent/file.ts`.
            names.set(path, nameIsPhysicalBasename ? suffix : `${originalName} — ${suffix}`)
            break
          }
        }
      }
    }
    return names
  }, [displayNameForPath, fileOrder, openFiles])

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [activeFilePath])

  return (
    <div className="flex h-9 flex-shrink-0 items-stretch border-b border-panel-border bg-tab-bg font-code text-[11px]">
      <div
        role="tablist"
        aria-label="Open files"
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto"
      >
        {fileOrder.length === 0 ? (
          <div className="flex flex-1 items-center px-3 text-muted">
            No file open · pick one from the explorer
          </div>
        ) : null}
        {fileOrder.map((path, index) => {
          const file = openFiles[path]
          if (!file) return null
          const active = path === activeFilePath
          const name = tabNames.get(path) ?? displayNameForPath(path)
          const fileTitle = titleForPath?.(path) ?? file.absolutePath
          const attentionLabel =
            file.externalChange === 'deleted'
              ? 'file deleted on disk'
              : file.conflict
                ? 'file changed on disk'
                : file.error
                  ? 'file error'
                  : file.surfaceWarning
                    ? 'file is no longer attached to this workspace'
                    : null
          return (
            // WHY the active tab paints with `bg-canvas`:
            //   the canvas color matches the Monaco editor surface below, so the
            //   active tab visually "merges" with the editor — a small cue that
            //   makes the tab strip feel attached to the editor instead of
            //   floating above it. The accent stripe at the top reinforces the
            //   selected state without recoloring the whole tab.
            <div
              key={path}
              role="presentation"
              onMouseDown={event => {
                if (event.button !== 1) return
                event.preventDefault()
                onClose(path)
              }}
              className={`group relative flex min-w-[140px] max-w-[240px] items-stretch border-r border-panel-border ${
                active
                  ? 'bg-tab-active-bg text-ink'
                  : 'bg-tab-bg text-ink-dim hover:bg-tab-hover-bg hover:text-ink'
              }`}
            >
              {active && (
                <span
                  className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-tab-accent"
                  aria-hidden="true"
                />
              )}
              <button
                ref={active ? activeTabRef : undefined}
                type="button"
                role="tab"
                id={`editor-tab-${file.generation}`}
                aria-controls={`editor-panel-${file.generation}`}
                data-editor-path={path}
                aria-selected={active}
                aria-label={`${name} — ${fileTitle}${file.dirty ? ', modified' : ''}${attentionLabel ? `, ${attentionLabel}` : ''}`}
                tabIndex={active ? 0 : -1}
                onClick={() => onActivate(path, { focusEditor: true })}
                onKeyDown={event => {
                  if (event.key === 'Delete') {
                    event.preventDefault()
                    onClose(path)
                    return
                  }
                  let nextIndex: number | null = null
                  if (event.key === 'ArrowLeft') nextIndex = Math.max(0, index - 1)
                  if (event.key === 'ArrowRight') {
                    nextIndex = Math.min(fileOrder.length - 1, index + 1)
                  }
                  if (event.key === 'Home') nextIndex = 0
                  if (event.key === 'End') nextIndex = fileOrder.length - 1
                  if (nextIndex === null || nextIndex === index) return
                  event.preventDefault()
                  const tabs = event.currentTarget
                    .closest('[role="tablist"]')
                    ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  const nextPath = fileOrder[nextIndex]
                  // A tablist is a composite widget: arrows move selection while
                  // focus remains in the strip. Requesting Monaco focus here made
                  // exactly one arrow press work before the keyboard was pulled
                  // into the editor.
                  if (nextPath) onActivate(nextPath, { focusEditor: false })
                  tabs?.[nextIndex]?.focus()
                }}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 text-left"
                title={`${fileTitle}${attentionLabel ? ` — ${attentionLabel}` : ''}`}
              >
                <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                  <FileIcon name={file.absolutePath} />
                </span>
                <span className="truncate">{name}</span>
                {file.dirty && (
                  <span
                    className="ml-1 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-tab-accent"
                    aria-label="modified"
                  />
                )}
                {attentionLabel && (
                  <span
                    className="ml-0.5 flex-shrink-0 font-sans text-[11px] font-semibold text-danger"
                    aria-label={attentionLabel}
                    title={file.error ?? file.surfaceWarning ?? attentionLabel}
                  >
                    !
                  </span>
                )}
              </button>
              <button
                type="button"
                tabIndex={-1}
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
      <div className="flex flex-shrink-0 items-center gap-1 border-l border-panel-border px-1.5">
        <button
          type="button"
          disabled={saveDisabled}
          onClick={onSave}
          title="Save active file (⌘S)"
          aria-label="Save active file"
          className="rounded px-1.5 py-0.5 text-muted hover:bg-surface-hi hover:text-ink disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
        >
          Save
        </button>
        <button
          type="button"
          disabled={saveAllDisabled}
          onClick={onSaveAll}
          aria-busy={saveAllPending || undefined}
          title={saveAllPending ? 'Saving all modified files' : 'Save all modified files'}
          aria-label="Save all modified files"
          className="rounded px-1.5 py-0.5 text-muted hover:bg-surface-hi hover:text-ink disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted"
        >
          {saveAllPending ? 'Saving…' : 'Save All'}
        </button>
        {actions}
      </div>
    </div>
  )
}
