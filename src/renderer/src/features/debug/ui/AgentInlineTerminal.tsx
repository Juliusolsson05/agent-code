import { memo, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

import {
  THEME_CHANGED_EVENT,
  getActiveAppFontFamily,
} from '@renderer/app-state/settings/theme'
import { readXtermTheme, syncXtermTheme } from '@renderer/workspace/tile-tree/xtermTheme'
import { createTerminalInputForwarder } from '@renderer/workspace/tile-tree/terminalInputForwarder'
import { subscribeToAgentPtyData } from '@renderer/workspace/terminal/sessionDataDispatcher'
import { attachXtermWebglRenderer } from '@renderer/workspace/terminal/xtermWebglRenderer'

type Props = {
  sessionId: string
  active: boolean
}

// AgentInlineTerminal — debug-only xterm terminal over a Claude/Codex session's
// real underlying PTY.
//
// Why this is NOT TerminalLeaf:
//   TerminalLeaf owns a plain shell pane, so it is allowed to resize
//   a shell process. This component attaches to an already-running
//   provider TUI and intentionally becomes an interactive terminal
//   while mounted: xterm.js handles input/rendering, sendInput writes
//   to the provider PTY, and resize() tells Claude/Codex the current
//   terminal dimensions. That is what makes it a real inline terminal
//   instead of a passive snapshot.
//
// Why it is writable:
//   The user asked for an inline terminal, not a passive transcript.
//   Keystrokes go through the same sendInput(sessionId, data) route as
//   the normal composer, but intentionally bypass composer affordances
//   such as prompt history and slash-mode. This is a raw provider TUI.

// Its props are scalar identity/visibility, while xterm owns live output. Feed
// updates in the surrounding debug rail must not revisit this React subtree.
export const AgentInlineTerminal = memo(function AgentInlineTerminal({ sessionId, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let webglRenderer: ReturnType<typeof attachXtermWebglRenderer> | null = null
    let onDataDisposable: { dispose(): void } | null = null
    let offPtyData: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null
    let rafId: number | null = null
    let disposed = false
    // Tracked outside the try so cleanup detaches the listener whether
    // or not mount made it past Terminal construction.
    let onThemeChangedListener: ((e: Event) => void) | null = null

    try {
      term = new Terminal({
        cursorBlink: true,
        convertEol: false,
        // See TerminalLeaf.tsx for the full rationale — xterm renders
        // to a canvas and can't read CSS variables, so we resolve the
        // user-picked font through the settings/theme layer and re-
        // apply via the THEME_CHANGED_EVENT listener below.
        fontFamily: getActiveAppFontFamily(),
        fontSize: 10,
        scrollback: 2000,
        theme: readXtermTheme(),
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      webglRenderer = attachXtermWebglRenderer(term)
      termRef.current = term

      let lastCols = 0
      let lastRows = 0
      const fitAndResizeBackend = () => {
        rafId = null
        if (disposed || !term || !fit) return
        try {
          fit.fit()
          const { cols, rows } = term
          if (cols > 0 && rows > 0 && (cols !== lastCols || rows !== lastRows)) {
            lastCols = cols
            lastRows = rows
            void window.api.resize(sessionId, cols, rows)
          }
        } catch {
          // Hidden or zero-sized debug rails can briefly throw while
          // React is mounting/unmounting panels. The next observer tick
          // or manual panel reopen gives xterm a real box again.
        }
      }

      // ResizeObserver can fire repeatedly while a rail is dragged and may
      // notify again after fit changes xterm's DOM. One layout read per frame
      // and one PTY notification per changed cell grid avoid redundant provider
      // repaints competing with keystrokes. Do not debounce until resizing ends:
      // the visible terminal must keep following the user's drag.
      const scheduleFit = () => {
        if (disposed || rafId !== null) return
        rafId = window.requestAnimationFrame(fitAndResizeBackend)
      }
      scheduleFit()
      resizeObserver = new ResizeObserver(scheduleFit)
      resizeObserver.observe(container)

      // See terminalInputForwarder.ts (#745): replies to replayed content
      // are dropped, live chunks are coalesced per tick.
      const forwarder = createTerminalInputForwarder(data => {
        void window.api.sendInput(sessionId, data)
      })
      onDataDisposable = term.onData(data => {
        forwarder.onData(data)
      })

      let attachedBackfillDone = false
      const backlogQueue: string[] = []
      offPtyData = subscribeToAgentPtyData(sessionId, data => {
        if (!attachedBackfillDone) {
          backlogQueue.push(data)
          return
        }
        term?.write(data)
      })

      void window.api.attachAgentPty(sessionId).then(buffer => {
        if (disposed || termRef.current !== term) return
        const liveTerm = term
        if (!liveTerm) return
        void forwarder.replay(liveTerm, [buffer ?? '', backlogQueue.join('')])
        backlogQueue.length = 0
        attachedBackfillDone = true
        liveTerm.focus()
      })

      // Live font updates — see TerminalLeaf.tsx for the rationale.
      // applyTheme dispatches THEME_CHANGED_EVENT after mutating the
      // CSS variable, so re-reading via getActiveAppFontFamily here
      // always sees the new value.
      onThemeChangedListener = (): void => {
        if (!term) return
        term.options.fontFamily = getActiveAppFontFamily()
        syncXtermTheme(term)
        scheduleFit()
      }
      window.addEventListener(THEME_CHANGED_EVENT, onThemeChangedListener)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AgentInlineTerminal] xterm init failed:', err)
    }

    return () => {
      disposed = true
      if (rafId !== null) window.cancelAnimationFrame(rafId)
      resizeObserver?.disconnect()
      onDataDisposable?.dispose()
      offPtyData?.()
      webglRenderer?.dispose()
      if (onThemeChangedListener) {
        window.removeEventListener(THEME_CHANGED_EVENT, onThemeChangedListener)
      }
      void window.api.detachAgentPty(sessionId)
      term?.dispose()
      termRef.current = null
    }
  }, [active, sessionId])

  return (
    <div
      className="rounded-slab
        h-[260px] min-h-[180px] w-full
        border border-border bg-canvas
        overflow-hidden relative
      "
      onMouseDown={() => termRef.current?.focus()}
    >
      <div ref={containerRef} className="h-full w-full overflow-hidden relative" />
    </div>
  )
})
