import { useEffect, useMemo, useRef, useState } from 'react'

import { fuzzyMatch } from '@renderer/features/command-palette/lib/rankCommands'
import { basename } from '@renderer/features/editor/lib/path'
import { FileIcon } from '@renderer/features/editor/lib/fileIcon'
import { openFileInGlobalEditor } from '@renderer/features/global-editor/openFileInGlobalEditor'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'

// Quick Open (⌘P) — fuzzy file-name jump for the Global Editor (#513).
//
// WHY the whole index is fetched once per overlay open instead of
// searching per keystroke in main: the recursive lister is bounded (20k
// paths) and junk-filtered, so the payload is a few MB at absolute
// worst — cheap to rank locally at typing speed, and it makes every
// keystroke latency-free instead of an IPC round trip. If a project
// legitimately outgrows the cap the footer says "index truncated" rather
// than silently missing files.

const MAX_VISIBLE = 50

type Props = {
  root: string
  onClose: () => void
}

// Basename-weighted ranking, adapted from the command palette's tier
// idea: people type file NAMES, so a basename hit must beat a path hit
// ("store" should find store.ts before src/stores/deep/thing.ts), and
// contiguous matches beat scattered-subsequence ones.
function scorePath(path: string, query: string): number {
  const q = query.toLowerCase()
  const base = basename(path).toLowerCase()
  const full = path.toLowerCase()
  if (base.startsWith(q)) return 5
  if (base.includes(q)) return 4
  if (full.includes(q)) return 3
  if (fuzzyMatch(base, query)) return 2
  if (fuzzyMatch(full, query)) return 1
  return 0
}

export function QuickOpenOverlay({ root, onClose }: Props) {
  const [files, setFiles] = useState<string[]>([])
  const [truncated, setTruncated] = useState(false)
  const [partialErrorCount, setPartialErrorCount] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    let stale = false
    setFiles([])
    setTruncated(false)
    setPartialErrorCount(0)
    setLoadError(null)
    setQuery('')
    setSelectedIndex(0)
    setLoading(true)
    void window.api
      .editorListFilesRecursive({ root })
      .then(result => {
        if (stale) return
        setLoading(false)
        if (!result.ok) {
          setLoadError(result.error)
          return
        }
        setFiles(result.files)
        setTruncated(result.truncated)
        setPartialErrorCount(result.errorCount)
      })
      .catch(err => {
        if (stale) return
        setLoading(false)
        setLoadError(err instanceof Error ? err.message : 'Failed to index project files.')
      })
    return () => {
      stale = true
    }
  }, [root])

  const matches = useMemo(() => {
    const q = query.trim()
    if (!q) {
      // A blank command palette should not look broken while the user decides
      // what to type. Open tabs are the best recency signal we already own;
      // fill the remainder with the bounded index in deterministic order.
      const recent = useGlobalEditorStore.getState().byCwd[root]?.fileOrder ?? []
      return [...new Set([...recent.slice().reverse(), ...files])].slice(0, MAX_VISIBLE)
    }
    const scored: Array<{ path: string; score: number }> = []
    for (const path of files) {
      const score = scorePath(path, q)
      if (score > 0) scored.push({ path, score })
    }
    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      // Shorter path first: with equal match quality the shallower file
      // is overwhelmingly more likely to be the intended one.
      if (a.path.length !== b.path.length) return a.path.length - b.path.length
      return a.path.localeCompare(b.path)
    })
    // Slice AFTER ranking — bounded DOM, but the ranking saw everything.
    return scored.slice(0, MAX_VISIBLE).map(entry => entry.path)
  }, [files, query])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    setSelectedIndex(index => Math.max(0, Math.min(index, matches.length - 1)))
  }, [matches.length])

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>(
      `[data-quick-open-index="${selectedIndex}"]`,
    )
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const openSelected = async (path: string | undefined) => {
    if (!path || loading) return
    const result = await openFileInGlobalEditor({ root, path })
    if (result.ok) onClose()
    else {
      setLoadError(result.error)
      inputRef.current?.focus()
    }
  }

  return (
    <Dialog
      open
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent className="left-1/2 top-[12vh] flex w-[520px] max-w-[90vw] -translate-x-1/2 translate-y-0 flex-col overflow-hidden p-0 font-code">
        <DialogTitle className="sr-only">Quick Open File</DialogTitle>
        <DialogDescription className="sr-only">
          Type part of a file name or path, then use the arrow keys and Enter to open it.
        </DialogDescription>
        <input
          ref={inputRef}
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-open-results"
          aria-activedescendant={
            matches[selectedIndex] ? `quick-open-option-${selectedIndex}` : undefined
          }
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              if (matches.length > 0) {
                setSelectedIndex(prev => Math.min(prev + 1, matches.length - 1))
              }
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSelectedIndex(prev => Math.max(prev - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              void openSelected(matches[selectedIndex])
            }
          }}
          placeholder="Go to file…"
          className="border-b border-border bg-canvas px-3 py-2 text-[13px] text-ink outline-none placeholder:text-muted"
        />
        <div
          ref={listRef}
          id="quick-open-results"
          role="listbox"
          aria-label="Matching project files"
          className="max-h-[50vh] overflow-y-auto py-1"
        >
          {loadError ? (
            <div role="alert" className="px-3 py-2 text-[11px] text-danger">{loadError}</div>
          ) : loading ? (
            <div role="status" aria-live="polite" className="px-3 py-2 text-[11px] text-muted">
              Indexing project files…
            </div>
          ) : (
            matches.map((path, index) => {
              const name = basename(path)
              const selected = index === selectedIndex
              return (
                <button
                  key={path}
                  id={`quick-open-option-${index}`}
                  type="button"
                  tabIndex={-1}
                  role="option"
                  aria-selected={selected}
                  data-quick-open-index={index}
                  onClick={() => void openSelected(path)}
                  onMouseDown={event => event.preventDefault()}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] ${
                    selected ? 'bg-accent-soft text-ink' : 'text-ink-dim hover:bg-surface-hi'
                  }`}
                >
                  <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                    <FileIcon name={name} />
                  </span>
                  <span className="flex-shrink-0">{name}</span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-muted">{path}</span>
                </button>
              )
            })
          )}
          {!loading && !loadError && query.trim() && matches.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted">No files match.</div>
          )}
        </div>
        {truncated && (
          <div className="border-t border-border px-3 py-1 text-[10px] text-muted">
            Index truncated at 20k files — results may be incomplete.
          </div>
        )}
        {partialErrorCount > 0 && (
          <div className="border-t border-border px-3 py-1 text-[10px] text-warning">
            {partialErrorCount} director{partialErrorCount === 1 ? 'y was' : 'ies were'} unreadable;
            results are partial.
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
