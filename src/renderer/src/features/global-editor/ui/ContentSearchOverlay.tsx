import { useEffect, useMemo, useRef, useState } from 'react'

import type { EditorFsSearchMatch } from '@shared/types/editorFs'
import { basename } from '@renderer/features/editor/lib/path'
import { FileIcon } from '@renderer/features/editor/lib/fileIcon'
import { openFileInGlobalEditor } from '@renderer/features/global-editor/openFileInGlobalEditor'

// Project content search (⌘⇧F) for the Global Editor (#513).
//
// WHY an overlay rather than a sidebar mode: the explorer pane is
// deliberately dumb (tree + mutations); a search surface needs a query
// input, result virtualization, and keyboard navigation — grafting a
// second mode into the tree component would double its state machine.
// The overlay also matches Quick Open, so the two search entries feel
// like one family.
//
// Search execution is debounced 300ms and generation-guarded: the
// main-process scan is bounded but not instant on big repos, and a slow
// early response must never clobber the results of a newer query (same
// stale-response pattern as ExplorerPane.loadGenerationRef).

type Props = {
  root: string
  onClose: () => void
}

type SearchState = {
  matches: EditorFsSearchMatch[]
  truncated: boolean
  filesScanned: number
  error: string | null
  searching: boolean
}

const INITIAL_STATE: SearchState = {
  matches: [],
  truncated: false,
  filesScanned: 0,
  error: null,
  searching: false,
}

export function ContentSearchOverlay({ root, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [state, setState] = useState<SearchState>(INITIAL_STATE)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const generationRef = useRef(0)

  useEffect(() => {
    const generation = ++generationRef.current
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setState(INITIAL_STATE)
      return
    }
    setState(prev => ({ ...prev, searching: true }))
    const timer = window.setTimeout(() => {
      void window.api
        .editorSearchContent({ root, query: trimmed, caseSensitive })
        .then(result => {
          if (generation !== generationRef.current) return
          if (!result.ok) {
            setState({ ...INITIAL_STATE, error: result.error })
            return
          }
          setState({
            matches: result.matches,
            truncated: result.truncated,
            filesScanned: result.filesScanned,
            error: null,
            searching: false,
          })
          setSelectedIndex(0)
        })
    }, 300)
    return () => window.clearTimeout(timer)
  }, [caseSensitive, query, root])

  // Group by file for display; keep a flat list for keyboard navigation.
  const grouped = useMemo(() => {
    const byFile = new Map<string, EditorFsSearchMatch[]>()
    for (const match of state.matches) {
      const list = byFile.get(match.path)
      if (list) list.push(match)
      else byFile.set(match.path, [match])
    }
    return [...byFile.entries()]
  }, [state.matches])

  const openMatch = (match: EditorFsSearchMatch | undefined) => {
    if (!match) return
    void openFileInGlobalEditor({
      root,
      path: match.path,
      line: match.line,
      column: match.column,
    })
    onClose()
  }

  // Highlight the hit inside the preview line. Index found client-side
  // (case-folded like the search) because previews are trimmed server-side
  // and the original column may fall outside the trimmed window.
  const renderPreview = (preview: string) => {
    const haystack = caseSensitive ? preview : preview.toLowerCase()
    const needle = caseSensitive ? query.trim() : query.trim().toLowerCase()
    const at = haystack.indexOf(needle)
    if (at === -1) return <span className="truncate">{preview}</span>
    return (
      <span className="truncate">
        {preview.slice(0, at)}
        <span className="bg-accent-soft text-ink">
          {preview.slice(at, at + needle.length)}
        </span>
        {preview.slice(at + needle.length)}
      </span>
    )
  }

  let flatIndex = -1

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-[10vh]"
      onMouseDown={onClose}
    >
      <div
        className="flex w-[640px] max-w-[92vw] flex-col overflow-hidden rounded border border-border bg-surface font-code shadow-xl"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border bg-canvas px-3">
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
                setSelectedIndex(prev => Math.min(prev + 1, state.matches.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelectedIndex(prev => Math.max(prev - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                openMatch(state.matches[selectedIndex])
              }
            }}
            placeholder="Search in files…"
            className="min-w-0 flex-1 bg-transparent py-2 text-[13px] text-ink outline-none placeholder:text-muted"
          />
          <button
            type="button"
            title="Match case"
            aria-pressed={caseSensitive}
            onClick={() => setCaseSensitive(prev => !prev)}
            className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
              caseSensitive
                ? 'border-accent text-ink'
                : 'border-border text-muted hover:text-ink'
            }`}
          >
            Aa
          </button>
        </div>
        <div className="max-h-[55vh] overflow-y-auto py-1">
          {state.error ? (
            <div className="px-3 py-2 text-[11px] text-danger">{state.error}</div>
          ) : (
            grouped.map(([path, matches]) => (
              <div key={path}>
                <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-ink">
                  <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                    <FileIcon name={basename(path)} />
                  </span>
                  <span className="truncate">{path}</span>
                  <span className="text-muted">({matches.length})</span>
                </div>
                {matches.map(match => {
                  flatIndex += 1
                  const index = flatIndex
                  const selected = index === selectedIndex
                  return (
                    <button
                      key={`${match.path}:${match.line}:${match.column}`}
                      type="button"
                      onClick={() => openMatch(match)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={`flex w-full items-center gap-2 py-0.5 pl-9 pr-3 text-left text-[11px] ${
                        selected ? 'bg-accent-soft text-ink' : 'text-ink-dim hover:bg-surface-hi'
                      }`}
                    >
                      <span className="w-8 flex-shrink-0 text-right text-[10px] text-muted">
                        {match.line}
                      </span>
                      {renderPreview(match.preview)}
                    </button>
                  )
                })}
              </div>
            ))
          )}
          {!state.error &&
            !state.searching &&
            query.trim().length >= 2 &&
            state.matches.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-muted">No matches.</div>
            )}
        </div>
        <div className="flex items-center justify-between border-t border-border px-3 py-1 text-[10px] text-muted">
          <span>
            {state.searching
              ? 'Searching…'
              : `${state.matches.length} match${state.matches.length === 1 ? '' : 'es'} · ${state.filesScanned} files scanned`}
          </span>
          {state.truncated && <span>results truncated</span>}
        </div>
      </div>
    </div>
  )
}
