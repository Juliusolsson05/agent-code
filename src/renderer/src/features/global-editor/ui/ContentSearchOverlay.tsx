import { useEffect, useMemo, useRef, useState } from 'react'

import type { EditorFsSearchMatch } from '@shared/types/editorFs'
import type { EditorFsSearchStopReason } from '@shared/types/editorFs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
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
  errorCount: number
  stopReason: EditorFsSearchStopReason
}

const INITIAL_STATE: SearchState = {
  matches: [],
  truncated: false,
  filesScanned: 0,
  error: null,
  searching: false,
  errorCount: 0,
  stopReason: 'complete',
}

export function ContentSearchOverlay({ root, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [state, setState] = useState<SearchState>(INITIAL_STATE)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const generationRef = useRef(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const generation = ++generationRef.current
    // Searching whitespace is valid (and useful for formatting audits). Do
    // not trim before IPC: that silently changes the user's search language.
    if (query.length === 0) {
      setState(INITIAL_STATE)
      // An empty query is also the cancellation signal for main's
      // per-renderer generation. Without it, clearing the input hides stale
      // results but the previous repository walk keeps consuming I/O.
      void window.api.editorSearchContent({ root, query: '', caseSensitive })
      return
    }
    // Old results belong to a different query/root and must stop being
    // actionable immediately; generation checks alone only protect the final
    // state write, not Enter pressed while the replacement scan is running.
    setState({ ...INITIAL_STATE, searching: true })
    setSelectedIndex(0)
    const timer = window.setTimeout(() => {
      void window.api
        .editorSearchContent({ root, query, caseSensitive })
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
            errorCount: result.errorCount,
            stopReason: result.stopReason,
          })
          setSelectedIndex(0)
        })
        .catch(err => {
          if (generation !== generationRef.current) return
          setState({
            ...INITIAL_STATE,
            error: err instanceof Error ? err.message : 'Project search failed.',
          })
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      void window.api.editorSearchContent({ root, query: '', caseSensitive })
    }
  }, [caseSensitive, query, root])

  useEffect(() => {
    setSelectedIndex(index => Math.max(0, Math.min(index, state.matches.length - 1)))
  }, [state.matches.length])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-content-search-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

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

  const openMatch = async (match: EditorFsSearchMatch | undefined) => {
    if (!match || state.searching) return
    const result = await openFileInGlobalEditor({
      root,
      path: match.path,
      line: match.line,
      column: match.column,
    })
    if (result.ok) onClose()
    else {
      setState(current => ({ ...current, error: result.error }))
      inputRef.current?.focus()
    }
  }

  // Highlight the hit inside the preview line. Index found client-side
  // (case-folded like the search) because previews are trimmed server-side
  // and the original column may fall outside the trimmed window.
  const renderPreview = (match: EditorFsSearchMatch) => {
    const at = match.previewMatchOffset
    if (at < 0 || at >= match.preview.length) {
      return <span className="truncate">{match.preview}</span>
    }
    return (
      <span className="truncate">
        {match.preview.slice(0, at)}
        <span className="bg-accent-soft text-ink">
          {match.preview.slice(at, at + match.previewMatchLength)}
        </span>
        {match.preview.slice(at + match.previewMatchLength)}
      </span>
    )
  }

  let flatIndex = -1

  return (
    <Dialog
      open
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent className="top-[10vh] flex w-[640px] max-w-[92vw] -translate-y-0 flex-col overflow-hidden p-0 font-code">
        <DialogTitle className="sr-only">Search in project files</DialogTitle>
        <DialogDescription className="sr-only">
          Enter text to search, then use the arrow keys and Enter to open a result.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b border-border bg-canvas px-3">
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-label="Search in files"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="content-search-results"
            aria-activedescendant={
              state.matches[selectedIndex] ? `content-search-option-${selectedIndex}` : undefined
            }
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (state.matches.length > 0) {
                  setSelectedIndex(prev => Math.min(prev + 1, state.matches.length - 1))
                }
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelectedIndex(prev => Math.max(prev - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                void openMatch(state.matches[selectedIndex])
              }
            }}
            placeholder="Search in files…"
            className="min-w-0 flex-1 bg-transparent py-2 text-[13px] text-ink outline-none placeholder:text-muted"
          />
          <button
            type="button"
            title="Match case"
            aria-label="Match case"
            aria-pressed={caseSensitive}
            onClick={() => {
              setCaseSensitive(prev => !prev)
              inputRef.current?.focus()
            }}
            className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${
              caseSensitive ? 'border-accent text-ink' : 'border-border text-muted hover:text-ink'
            }`}
          >
            Aa
          </button>
        </div>
        <div
          ref={listRef}
          id="content-search-results"
          role="listbox"
          aria-label="Project search results"
          className="max-h-[55vh] overflow-y-auto py-1"
        >
          {state.error ? (
            <div role="alert" className="px-3 py-2 text-[11px] text-danger">
              {state.error}
            </div>
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
                      id={`content-search-option-${index}`}
                      type="button"
                      tabIndex={-1}
                      role="option"
                      aria-selected={selected}
                      data-content-search-index={index}
                      onClick={() => void openMatch(match)}
                      onMouseDown={event => event.preventDefault()}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={`flex w-full items-center gap-2 py-0.5 pl-9 pr-3 text-left text-[11px] ${
                        selected ? 'bg-accent-soft text-ink' : 'text-ink-dim hover:bg-surface-hi'
                      }`}
                    >
                      <span className="w-8 flex-shrink-0 text-right text-[10px] text-muted">
                        {match.line}
                      </span>
                      {renderPreview(match)}
                    </button>
                  )
                })}
              </div>
            ))
          )}
          {!state.error && !state.searching && query.length > 0 && state.matches.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted">No matches.</div>
          )}
        </div>
        <div
          aria-live="polite"
          className="flex items-center justify-between border-t border-border px-3 py-1 text-[10px] text-muted"
        >
          <span>
            {state.searching
              ? 'Searching…'
              : `${state.matches.length} match${state.matches.length === 1 ? '' : 'es'} · ${state.filesScanned} files scanned`}
          </span>
          {state.truncated && <span>results truncated</span>}
          {state.errorCount > 0 && (
            <span>
              {state.errorCount} unreadable path
              {state.errorCount === 1 ? '' : 's'}
            </span>
          )}
          {state.stopReason === 'bytes' && <span>64 MB scan budget reached</span>}
          {state.stopReason === 'deadline' && <span>5 second scan budget reached</span>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
