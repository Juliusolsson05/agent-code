import { useCallback, useEffect, useMemo, useState } from 'react'

import { sanitizeHtml } from '@renderer/lib/sanitizeHtml'

// HtmlDebugPanel — grabs the focused pane's `outerHTML` and shows
// it as copy-pasteable text. Fourth in the debug-panel family
// (DebugPanel / FeedDebugPanel / ProxyDebugPanel). Toggled from
// the command palette, renders as a side rail next to the pane.
//
// Why this exists:
// Rendering bugs are hard to describe in prose. "Here is the
// exact DOM the app is painting for this pane right now" is the
// single most useful artifact for triaging them — paste it into
// an LLM, diff it against a known-good snapshot, or inspect the
// structure/class list directly. The existing three debug panels
// expose state and parsed events, not the rendered DOM itself.
//
// Capture mechanism:
// TileLeaf's root <div> carries `data-pane-id={sessionId}`. We
// querySelector for that node and read `.outerHTML`. Why a data
// attribute instead of a React ref: the other debug panels are
// stateless about the DOM (they read from runtime props only).
// Forwarding a ref out of TileLeaf would require a Map<SessionId,
// HTMLDivElement> threaded through the workspace — lots of
// plumbing for a single querySelector call. The data attribute
// is also a compounding investment for any future DOM-targeting
// debug work.
//
// Snapshot timing:
// The preview is frozen, not live. Taken on mount and on explicit
// "Refresh" click. An auto-updating preview would reflow a
// multi-KB string into React on every keystroke, scroll tick, or
// stream delta in the pane — bad for perf and produces a moving
// target that's worse for debugging than a clean snapshot.
//
// Two view modes:
//   raw    — exactly what the browser serialized, with all the
//            Monaco guts, hljs token spans, and multi-line class
//            attributes intact. Closest to truth but useless for
//            LLM consumption because the noise swamps the signal.
//   clean  — sanitized for pasting into an LLM. Monaco instances
//            collapsed to <pre><code>visible-text</code></pre>,
//            hljs spans unwrapped to plain text inside <code>,
//            class="..." whitespace normalized, tree pretty-
//            printed. The transforms are deterministic and tend
//            to cut capture size by 5-10× on typical panes.
//            Full rationale for each rule is in sanitizeHtml.ts.
//
// Both modes come from the same single capture. Switching is free
// (clean is memoized off the raw string). Copy writes whichever
// mode is active.

type HtmlDebugMode = 'raw' | 'clean'

type Props = {
  sessionId: string
  kind: string
  onClose: () => void
}

type Capture = {
  html: string
  capturedAt: number
  // When null the query returned no node (e.g. focused pane was
  // closed between mount and capture). We render a dedicated
  // empty state for that instead of a bare empty <pre>.
  found: boolean
}

// Render cap: huge panes (thousands of feed entries) can produce
// hundreds of KB of HTML. Dropping that full string into a <pre>
// each render is fine for small captures but hitches for large
// ones. We cap ONLY the rendered preview — the copy button
// always writes the full string from state. Keep the cap well
// above typical real-world pane sizes so it kicks in only for
// pathological cases. Applies to raw AND clean modes.
const PREVIEW_RENDER_CAP_CHARS = 200_000

function capturePane(sessionId: string): Capture {
  const node = document.querySelector(`[data-pane-id="${sessionId}"]`)
  if (!(node instanceof HTMLElement)) {
    return { html: '', capturedAt: Date.now(), found: false }
  }
  return {
    html: node.outerHTML,
    capturedAt: Date.now(),
    found: true,
  }
}

function formatSize(chars: number): string {
  if (chars < 1024) return `${chars} chars`
  return `${chars.toLocaleString()} chars · ${(chars / 1024).toFixed(1)} KB`
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

export function HtmlDebugPanel({ sessionId, kind, onClose }: Props) {
  // Initial capture happens once per mount and once per focused-
  // session change. The effect below handles both cases via its
  // [sessionId] dep array. Seeding state with a synchronous
  // capture would race: on first mount the TileLeaf for this
  // session has already rendered (the panel only opens via a
  // palette action, which is well after tree mount), so a
  // useEffect-driven initial capture is reliable and keeps the
  // "capture" path single-sourced.
  const [capture, setCapture] = useState<Capture>(() => capturePane(sessionId))
  const [copyToast, setCopyToast] = useState<string | null>(null)
  // Default to 'clean' because the stated use case is "paste into
  // an LLM" — showing the clean output first matches what the
  // user will almost always want. The Raw toggle is there for
  // sanity-checking sanitizer transforms against the source of
  // truth, not for day-to-day use.
  const [mode, setMode] = useState<HtmlDebugMode>('clean')

  useEffect(() => {
    setCapture(capturePane(sessionId))
  }, [sessionId])

  // Clean output is derived from the raw capture via a pure
  // function. Memoized so switching between modes (or any
  // unrelated re-render) doesn't re-parse the DOM string.
  // sanitizeHtml internally builds a detached document; we pay
  // that cost once per capture, not once per render.
  const cleanHtml = useMemo(() => {
    if (!capture.found) return ''
    return sanitizeHtml(capture.html)
  }, [capture])

  const activeHtml = mode === 'clean' ? cleanHtml : capture.html

  const refresh = useCallback(() => {
    setCapture(capturePane(sessionId))
  }, [sessionId])

  const copy = useCallback(async () => {
    if (!capture.found || activeHtml.length === 0) return
    try {
      await navigator.clipboard.writeText(activeHtml)
      setCopyToast(`copied ${mode} · ${formatSize(activeHtml.length)}`)
    } catch (err) {
      setCopyToast(`copy failed: ${String((err as Error).message ?? err)}`)
    }
    // ~1.6s matches FeedDebugPanel.tsx:53 — consistency across the
    // debug panels. The timer is intentionally shorter than the
    // workspace paneToast (2000ms) because this toast is smaller
    // and inline with the control that triggered it.
    window.setTimeout(() => setCopyToast(null), 1600)
  }, [capture.found, activeHtml, mode])

  // Truncated text for rendering only. Kept in its own memo so
  // the substring + concatenation doesn't run on every re-render,
  // only when the active HTML changes. The copy button uses
  // activeHtml directly — never this truncated value.
  const previewText = useMemo(() => {
    if (!capture.found) return ''
    if (activeHtml.length <= PREVIEW_RENDER_CAP_CHARS) return activeHtml
    const shown = activeHtml.slice(0, PREVIEW_RENDER_CAP_CHARS)
    return (
      shown +
      `\n\n[… preview truncated at ${PREVIEW_RENDER_CAP_CHARS.toLocaleString()} chars; ` +
      `copy writes the full ${formatSize(activeHtml.length)}]`
    )
  }, [capture.found, activeHtml])

  // Reduction ratio for the size line when in clean mode. Gives
  // a quick read on "how much noise did sanitization kill" —
  // typical panes land between 70-95% reduction. Only shown in
  // clean mode; redundant in raw mode.
  const reductionNote = useMemo(() => {
    if (mode !== 'clean') return null
    if (!capture.found || capture.html.length === 0) return null
    const ratio = 1 - cleanHtml.length / capture.html.length
    if (ratio <= 0) return null
    return `−${(ratio * 100).toFixed(0)}% vs raw`
  }, [mode, capture, cleanHtml])

  const sizeLine = capture.found
    ? `${formatSize(activeHtml.length)} · captured ${formatTime(capture.capturedAt)}${
        reductionNote ? ` · ${reductionNote}` : ''
      }`
    : `no pane found for ${sessionId.slice(0, 8)}`

  return (
    <div className="
      h-full w-[540px] flex-shrink-0
      border-l border-border bg-[#0c0c0c]
      flex flex-col overflow-hidden
      text-[10px] font-code
    ">
      {/* Header — matches the existing debug panels: red uppercase
          title, row of action buttons on the right, × close.
          Width of 540px (not 380 like DebugPanel) because HTML
          wraps badly at narrower widths — FeedDebugPanel landed
          at 540 for the same reason. */}
      <div className="
        flex items-center justify-between
        px-3 py-2 border-b border-border
        text-[9px] text-red-400 uppercase tracking-wider
        select-none flex-shrink-0
      ">
        <span>debug — html ({kind})</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            className="text-muted hover:text-ink text-[10px] uppercase tracking-wider"
            title="Re-capture the focused pane's outerHTML"
          >
            ↻ refresh
          </button>
          <button
            type="button"
            onClick={copy}
            disabled={!capture.found || activeHtml.length === 0}
            className="text-muted hover:text-ink text-[10px] uppercase tracking-wider disabled:opacity-40 disabled:hover:text-muted"
            title={`Copy the ${mode} HTML to the clipboard`}
          >
            copy
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-ink text-[14px] leading-none"
            title="Close"
          >
            ×
          </button>
        </div>
      </div>

      {/* Mode toggle row. Inline tab-style: two text buttons with
          the active one underlined/accented. Placed as its own
          row (not in the header) so it's clearly part of the
          content area and so there's space for the hint text
          explaining what "clean" does on first encounter. */}
      <div className="
        flex items-center gap-4
        px-3 py-1.5 border-b border-border
        text-[10px] select-none flex-shrink-0
      ">
        <ModeTab label="clean" active={mode === 'clean'} onClick={() => setMode('clean')} />
        <ModeTab label="raw" active={mode === 'raw'} onClick={() => setMode('raw')} />
        <span className="text-muted text-[10px] ml-auto">
          {mode === 'clean'
            ? 'monaco + hljs stripped, classes normalized, pretty-printed'
            : 'exactly as the browser serialized it'}
        </span>
      </div>

      {/* Meta line + copy toast. The toast replaces the trailing
          side of the row transiently rather than overlaying the
          size line, so there's no layout shift and the user still
          sees the capture size while the toast is up. */}
      <div className="
        flex items-center justify-between
        px-3 py-1.5 border-b border-border
        text-[10px] text-ink-dim
        select-none flex-shrink-0
      ">
        <span>{sizeLine}</span>
        {copyToast && (
          <span className="text-accent">{copyToast}</span>
        )}
      </div>

      {/* Preview body — HTML rendered as text inside a <pre>.
          whitespace-pre-wrap + break-all so long class lists and
          attribute soup wrap instead of triggering horizontal
          scroll. overflow-auto lives on the <pre> so scroll
          ownership is local to the preview. */}
      <div className="flex-1 min-h-0 overflow-hidden p-2">
        {capture.found ? (
          <pre className="
            h-full w-full m-0
            bg-[#111] border border-[#222]
            px-2 py-1.5
            text-[10px] leading-[1.4] text-ink-dim
            whitespace-pre-wrap break-all
            overflow-auto
          ">
            {previewText}
          </pre>
        ) : (
          <div className="
            h-full flex items-center justify-center
            text-[11px] text-muted text-center px-6
          ">
            No TileLeaf with data-pane-id="{sessionId.slice(0, 8)}…" was found in
            the DOM. The pane may have been closed. Try refreshing or
            re-focusing a pane.
          </div>
        )}
      </div>
    </div>
  )
}

function ModeTab({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        uppercase tracking-wider text-[10px]
        border-b
        ${active
          ? 'text-accent border-accent'
          : 'text-muted border-transparent hover:text-ink'}
      `}
    >
      {label}
    </button>
  )
}
