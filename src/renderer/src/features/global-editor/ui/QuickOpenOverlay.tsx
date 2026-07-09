import { useEffect, useMemo, useRef, useState } from 'react'

import { fuzzyMatch } from '@renderer/features/command-palette/lib/rankCommands'
import { basename } from '@renderer/features/editor/lib/path'
import { FileIcon } from '@renderer/features/editor/lib/fileIcon'
import { openFileInGlobalEditor } from '@renderer/features/global-editor/openFileInGlobalEditor'

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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let stale = false
    void window.api.editorListFilesRecursive({ root }).then(result => {
      if (stale) return
      if (!result.ok) {
        setLoadError(result.error)
        return
      }
      setFiles(result.files)
      setTruncated(result.truncated)
    })
    return () => {
      stale = true
    }
  }, [root])

  const matches = useMemo(() => {
    const q = query.trim()
    // Empty query renders nothing rather than 20k rows — quick-open is a
    // typing surface, not a browser; the tree is one ⌘⇧E away.
    if (!q) return []
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

  const openSelected = (path: string | undefined) => {
    if (!path) return
    void openFileInGlobalEditor({ root, path })
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        className="flex w-[520px] max-w-[90vw] flex-col overflow-hidden rounded border border-border bg-surface font-code shadow-xl"
        onMouseDown={event => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose()
            } else if (event.key === 'ArrowDown') {
              event.preventDefault()
              setSelectedIndex(prev => Math.min(prev + 1, matches.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              setSelectedIndex(prev => Math.max(prev - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              openSelected(matches[selectedIndex])
            }
          }}
          placeholder="Go to file…"
          className="border-b border-border bg-canvas px-3 py-2 text-[13px] text-ink outline-none placeholder:text-muted"
        />
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {loadError ? (
            <div className="px-3 py-2 text-[11px] text-danger">{loadError}</div>
          ) : (
            matches.map((path, index) => {
              const name = basename(path)
              const selected = index === selectedIndex
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => openSelected(path)}
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
          {!loadError && query.trim() && matches.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted">No files match.</div>
          )}
        </div>
        {truncated && (
          <div className="border-t border-border px-3 py-1 text-[10px] text-muted">
            Index truncated at 20k files — results may be incomplete.
          </div>
        )}
      </div>
    </div>
  )
}
