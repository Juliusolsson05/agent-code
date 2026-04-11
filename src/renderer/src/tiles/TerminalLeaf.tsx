import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

import type { SessionId } from './types'
import type { Workspace } from './workspaceStore'

// TerminalLeaf — one pane that hosts a plain shell session.
//
// Counterpart to TileLeaf. Where TileLeaf owns the elaborate Claude
// Code UI (feed, composer, slash picker, streaming card, todo
// rendering, diff slabs, …), TerminalLeaf is the minimal VS Code-
// style integrated terminal: a single <div> containing an xterm.js
// instance. No feed, no composer, no overlays.
//
// Data flow:
//   main spawns a TerminalSession (shell PTY)
//     → emits 'session:terminal-data' IPC events with raw bytes
//     → this component writes them into its Terminal instance
//   user types in the focused xterm
//     → Terminal.onData fires with the keystroke bytes
//     → we IPC them back via window.api.sendInput
//   container resizes
//     → FitAddon recomputes cell dimensions
//     → we IPC the new cols/rows via window.api.resize
//     → main's TerminalSession.resize() calls node-pty's resize()
//
// Lifecycle:
//   - xterm.Terminal is instantiated on mount, disposed on unmount
//   - the IPC subscription is attached on mount and torn down on
//     unmount; main's session manager keeps the shell alive across
//     tab-switch remounts (session lifetime is NOT bound to this
//     component lifetime — the renderer just re-attaches to the
//     already-running session when it comes back)
//
// Why not memoize the Terminal across remounts: xterm.js isn't
// React-aware and a remount destroys the underlying <div> its
// renderer attaches to. We accept the cost of re-creating it on
// every remount (mostly invisible — the shell PTY on the main side
// keeps emitting bytes and we buffer them via a ref until attach).
// If remounts ever become hot we can add an off-screen cache.

type Props = {
  sessionId: SessionId
  focused: boolean
  onFocusRequest: () => void
  workspace: Workspace
}

export function TerminalLeaf({
  sessionId,
  focused,
  onFocusRequest,
  workspace: _workspace,
}: Props) {
  // The DOM node xterm.js renders into. We give it a fresh ref on
  // every mount; xterm's open() attaches on top.
  const containerRef = useRef<HTMLDivElement>(null)
  // The xterm instance itself. Kept in a ref so the effects below
  // can access it without triggering re-renders on every data tick.
  const termRef = useRef<Terminal | null>(null)
  // FitAddon instance — held for resize callbacks.
  const fitRef = useRef<FitAddon | null>(null)

  // Mount / unmount: create the Terminal, attach it to the container,
  // wire up the IPC listener for incoming PTY bytes, wire up
  // onData → sendInput for outgoing keystrokes, and install a
  // ResizeObserver so the terminal grows with the tile.
  //
  // Everything is torn down in the cleanup so a remount (tab switch)
  // starts from a clean slate. The underlying shell session on the
  // main side is NOT killed — the renderer just re-attaches.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Track resources here so the cleanup function can tear them
    // down whether mount succeeds or fails. Lexical closures on
    // these match the inner try block's scope.
    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let onDataDisposable: { dispose(): void } | null = null
    let offTerminalData: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null

    try {
      // Theme choice: leave xterm's default palette alone. The
      // user's shell prompt and tools assume a reasonable ANSI
      // baseline and we'd rather inherit that than pick values
      // that look great with one prompt and wrong with another.
      //
      // We deliberately do NOT set a transparent background here.
      // xterm.js accepts 8-char hex in theme.background only when
      // `allowTransparency: true` is also set, and the rendering
      // cost is non-trivial. Just let xterm use its default dark
      // background — it's close enough to bg-canvas that the
      // seam is invisible in practice.
      term = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily:
          '"JetBrains Mono", ui-monospace, Menlo, Monaco, monospace',
        fontSize: 13,
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      termRef.current = term
      fitRef.current = fit

      // Initial fit is deferred one frame. Reason: React's commit
      // phase has just run; the container's box has been inserted
      // into the DOM but its computed layout (flex cell width/
      // height) may not reflect the final size until the browser
      // performs layout after the commit. Running fit() inside the
      // useEffect body sometimes reads the pre-layout size as 0×0,
      // which makes xterm's grid collapse and the terminal paints
      // a tiny stripe in the corner. requestAnimationFrame fires
      // after layout but before paint, so the measurements are
      // correct AND we still update before the first frame the
      // user can actually see.
      requestAnimationFrame(() => {
        if (!term || !fit) return
        try {
          fit.fit()
          const { cols, rows } = term
          void window.api.resize(sessionId, cols, rows)
        } catch {
          // Zero-dimension containers still throw. The
          // ResizeObserver below will recover on the next tick.
        }
      })

      // Outgoing: keystrokes typed into the xterm go straight to
      // the shell via sendInput. No slash mode, no history
      // cycling, no composer — this is a raw terminal.
      onDataDisposable = term.onData(data => {
        void window.api.sendInput(sessionId, data)
      })

      // Incoming: raw bytes from the shell PTY. We subscribe ONCE
      // at mount; the handler filters by sessionId so multiple
      // terminal panes coexist without stomping on each other's
      // output.
      offTerminalData = window.api.onSessionTerminalData(
        ({ sessionId: sid, data }) => {
          if (sid !== sessionId) return
          term?.write(data)
        },
      )

      // Container resize observer. Whenever the tile's cell area
      // changes size (split drag, window resize, tab activation),
      // we re-fit the terminal and push the new cols/rows down to
      // the shell so programs like `vim` / `htop` / `less` see
      // the correct dimensions.
      resizeObserver = new ResizeObserver(() => {
        if (!term || !fit) return
        try {
          fit.fit()
          const { cols, rows } = term
          void window.api.resize(sessionId, cols, rows)
        } catch {
          // Swallow transient-layout errors the same way we
          // swallow them in TerminalSession.resize() on the
          // main side.
        }
      })
      resizeObserver.observe(container)
    } catch (err) {
      // Defensive: if xterm.js initialization throws for any
      // reason (missing CSS, API mismatch, renderer misconfig,
      // …), we want the PANE to fail visibly instead of the
      // whole React root crashing and taking the app down.
      // Historically a bad xterm mount blacked out the entire
      // window because xterm's absolutely-positioned rows
      // escaped to the viewport, so logging and bailing is the
      // safer move.
      // eslint-disable-next-line no-console
      console.error('[TerminalLeaf] xterm init failed:', err)
    }

    return () => {
      resizeObserver?.disconnect()
      onDataDisposable?.dispose()
      offTerminalData?.()
      term?.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // sessionId is the identity of the session we're attached to —
    // it's immutable for the lifetime of this component instance.
    // We still list it in deps so React's exhaustive-deps rule is
    // satisfied and any future code that changes sessionId would
    // force a clean re-mount.
  }, [sessionId])

  // When focus flips to this pane, move DOM focus into the terminal
  // so keystrokes go through xterm's onData. Without this a
  // newly-activated pane would need a mouse click before it could
  // accept keys.
  useEffect(() => {
    if (focused) termRef.current?.focus()
  }, [focused])

  return (
    <div
      className={`
        flex flex-col h-full min-h-0 min-w-0
        border ${focused ? 'border-accent' : 'border-border'}
        bg-canvas
      `}
      onMouseDown={onFocusRequest}
    >
      {/* Compact header to match TileLeaf's status strip so a
          mixed layout doesn't look ragged. We don't have CC-style
          live state to show, so just a static "terminal" label. */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-border bg-surface text-[10px] text-muted font-code select-none">
        <span>terminal</span>
        <span className="text-ink-dim">$</span>
      </div>

      {/* xterm.js mounts here.
          `relative` is load-bearing: xterm creates absolutely-
          positioned row elements inside this container. Without a
          `position: relative` (or any non-static) ancestor, those
          rows escape to the nearest positioned ancestor — which
          in our case is the BrowserWindow root — and paint over
          the entire UI. That's exactly the "application goes
          black when I open a terminal" bug.
          No padding here either — xterm manages its own inner
          spacing based on cell dimensions, and outer padding
          confuses FitAddon's size measurement (it reads the
          element's clientWidth/Height which includes padding). */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 min-w-0 overflow-hidden relative"
      />
    </div>
  )
}
