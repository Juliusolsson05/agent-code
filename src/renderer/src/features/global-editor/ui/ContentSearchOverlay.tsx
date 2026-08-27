import { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'

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
import { hasRecoverableBufferChanges } from '@renderer/features/editor/lib/bufferOps'
import { mergeSearchMatchesWithBuffers } from '@renderer/features/global-editor/lib/contentSearch'
import { openFileInGlobalEditor } from '@renderer/features/global-editor/openFileInGlobalEditor'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

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
  resultKey: string | null
}

const INITIAL_STATE: SearchState = {
  matches: [],
  truncated: false,
  filesScanned: 0,
  error: null,
  searching: false,
  errorCount: 0,
  stopReason: 'complete',
  resultKey: null,
}

export function ContentSearchOverlay({ root, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [state, setState] = useState<SearchState>(INITIAL_STATE)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [openError, setOpenError] = useState<string | null>(null)
  const [openingMatch, setOpeningMatch] = useState<string | null>(null)
  const generationRef = useRef(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const openBuffers = useGlobalEditorStore(
    useShallow(store => {
      const cwdState = store.byCwd[root]
      if (!cwdState) return []
      return cwdState.fileOrder.flatMap(path =>
        cwdState.openFiles[path] ? [cwdState.openFiles[path]] : [],
      )
    }),
  )
  const recoverableBuffers = useMemo(
    () => openBuffers.filter(hasRecoverableBufferChanges),
    [openBuffers],
  )
  const [searchableBufferSnapshots, setSearchableBufferSnapshots] = useState<
    Array<{ path: string; text: string }>
  >([])
  const recoverableBufferPathsRef = useRef<string[]>([])
  recoverableBufferPathsRef.current = recoverableBuffers.map(buffer => buffer.path)
  const recoverableBufferPathsKey = JSON.stringify(recoverableBufferPathsRef.current)
  const resultKey = `${caseSensitive ? 'case' : 'fold'}\0${query}`

  useEffect(() => {
    if (query.length === 0) {
      setSearchableBufferSnapshots([])
      return
    }
    // Disk search already waits for the user to pause. Live-buffer search must
    // do the same: a recoverable tab can be near the 8 MB read limit, and
    // synchronously scanning several such drafts on every store update makes
    // typing elsewhere visibly hitch while this overlay is open. The snapshot
    // retains the correctness contract—unsaved text wins—after a short pause.
    const timer = window.setTimeout(() => {
      setSearchableBufferSnapshots(
        recoverableBuffers.map(buffer => ({ path: buffer.path, text: buffer.currentText })),
      )
    }, 120)
    return () => window.clearTimeout(timer)
  }, [query, caseSensitive, recoverableBuffers])

  useEffect(() => {
    const generation = ++generationRef.current
    setOpenError(null)
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
    setState({ ...INITIAL_STATE, searching: true, resultKey })
    setSelectedIndex(0)
    const timer = window.setTimeout(() => {
      void window.api
        .editorSearchContent({
          root,
          query,
          caseSensitive,
          // Main deliberately skips these disk copies; the live merge below
          // searches the current buffer text first and preserves the same
          // global 500-result UI bound.
          excludePaths: [...recoverableBufferPathsRef.current],
        })
        .then(result => {
          if (generation !== generationRef.current) return
          if (!result.ok) {
            setState({ ...INITIAL_STATE, error: result.error, resultKey })
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
            resultKey,
          })
          setSelectedIndex(0)
        })
        .catch(err => {
          if (generation !== generationRef.current) return
          setState({
            ...INITIAL_STATE,
            error: err instanceof Error ? err.message : 'Project search failed.',
            resultKey,
          })
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      void window.api.editorSearchContent({ root, query: '', caseSensitive })
    }
    // Recoverable-path membership changes restart the disk scan so its
    // exclusion snapshot and 500-hit budget remain valid. Buffer text changes
    // intentionally do not: the renderer merge updates those live without
    // another repository walk.
  }, [caseSensitive, query, recoverableBufferPathsKey, resultKey, root])

  const displayedSearch = useMemo(() => {
    if (
      query.length === 0 ||
      state.searching ||
      state.error ||
      state.resultKey !== resultKey
    ) {
      return { matches: [] as EditorFsSearchMatch[], truncated: state.truncated }
    }
    const merged = mergeSearchMatchesWithBuffers(
      state.matches,
      searchableBufferSnapshots,
      query,
      caseSensitive,
    )
    return { matches: merged.matches, truncated: state.truncated || merged.truncated }
  }, [caseSensitive, query, resultKey, searchableBufferSnapshots, state])
  const displayedMatches = displayedSearch.matches
  const recoverableBuffersByPath = useMemo(
    () => new Map(recoverableBuffers.map(buffer => [buffer.path, buffer])),
    [recoverableBuffers],
  )

  useEffect(() => {
    setSelectedIndex(index => Math.max(0, Math.min(index, displayedMatches.length - 1)))
  }, [displayedMatches.length])

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-content-search-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Group by file for display; keep a flat list for keyboard navigation.
  const grouped = useMemo(() => {
    const byFile = new Map<string, EditorFsSearchMatch[]>()
    for (const match of displayedMatches) {
      const list = byFile.get(match.path)
      if (list) list.push(match)
      else byFile.set(match.path, [match])
    }
    return [...byFile.entries()]
  }, [displayedMatches])

  const openMatch = async (match: EditorFsSearchMatch | undefined) => {
    if (!match || state.searching || openingMatch) return
    const matchKey = `${match.path}:${match.line}:${match.column}`
    setOpeningMatch(matchKey)
    setOpenError(null)
    const editor = useGlobalEditorStore.getState()
    const liveBuffer = editor.byCwd[root]?.openFiles[match.path]
    if (liveBuffer && hasRecoverableBufferChanges(liveBuffer)) {
      // A deleted buffer has no disk path to reopen, and rereading a dirty
      // buffer adds latency while risking a conflict banner unrelated to this
      // navigation. The result was computed from this exact in-memory text,
      // so reveal it inside the existing buffer lifetime instead.
      editor.setActiveFile(root, match.path, {
        focus: true,
        selection: { line: match.line, column: match.column },
      })
      editor.showProjectEditor()
      onClose()
      return
    }
    const result = await openFileInGlobalEditor({
      root,
      path: match.path,
      line: match.line,
      column: match.column,
    })
    if (result.ok && result.opened) onClose()
    else if (result.ok) {
      setOpeningMatch(null)
      inputRef.current?.focus()
    } else {
      // Search results remain valid even when one file vanished between scan
      // and activation. Keep them selectable instead of replacing the entire
      // result list with a per-file open failure.
      setOpenError(`Could not open ${match.path}: ${result.error}`)
      setOpeningMatch(null)
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
              displayedMatches[selectedIndex]
                ? `content-search-option-${selectedIndex}`
                : undefined
            }
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (displayedMatches.length > 0) {
                  setSelectedIndex(prev => Math.min(prev + 1, displayedMatches.length - 1))
                }
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelectedIndex(prev => Math.max(prev - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                void openMatch(displayedMatches[selectedIndex])
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
            className={`flex-shrink-0 rounded-chip border px-1.5 py-0.5 text-[10px] ${
              caseSensitive ? 'border-accent text-ink' : 'border-border text-muted hover:text-ink'
            }`}
          >
            Aa
          </button>
        </div>
        {openError ? (
          <div role="alert" className="border-b border-border px-3 py-1.5 text-[11px] text-danger">
            {openError}
          </div>
        ) : null}
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
                  {recoverableBuffersByPath.has(path) && (
                    <span className="rounded-chip bg-accent-soft px-1 text-[9px] text-ink-dim">
                      {recoverableBuffersByPath.get(path)?.dirty ? 'unsaved' : 'in memory'}
                    </span>
                  )}
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
                      aria-busy={
                        openingMatch === `${match.path}:${match.line}:${match.column}` || undefined
                      }
                      data-content-search-index={index}
                      onClick={() => void openMatch(match)}
                      onMouseDown={event => event.preventDefault()}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={`flex w-full items-center gap-2 py-0.5 pl-9 pr-3 text-left text-[11px] ${
                        selected ? 'bg-accent-soft text-ink' : 'text-ink-dim hover:bg-surface-hi'
                      } ${openingMatch ? 'opacity-60' : ''}`}
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
          {!state.error &&
            !state.searching &&
            query.length > 0 &&
            displayedMatches.length === 0 && (
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
              : `${displayedMatches.length} match${displayedMatches.length === 1 ? '' : 'es'} · ${state.filesScanned} files scanned`}
          </span>
          {!state.searching && query.length > 0 && recoverableBuffers.length > 0 && (
            <span>
              {recoverableBuffers.length} live buffer
              {recoverableBuffers.length === 1 ? '' : 's'} included
            </span>
          )}
          {displayedSearch.truncated && <span>results truncated</span>}
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
