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

    // Theme choice: we don't override xterm's default palette. The
    // user's shell prompt and tools assume a reasonable 16-color
    // ANSI baseline and we'd rather inherit that than pick values
    // that look great with one prompt and wrong with another.
    // Background is made transparent so the tile's bg-canvas token
    // shows through — that way light mode and dark mode both Just Work.
    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily:
        '"JetBrains Mono", ui-monospace, Menlo, Monaco, monospace',
      fontSize: 13,
      // allowProposedApi lets us call APIs that aren't stable but we
      // need (fit addon reaches into them). Matches what
      // @xterm/addon-fit expects.
      allowProposedApi: true,
      theme: {
        background: '#00000000',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    // Initial fit so the shell starts with sensible cols/rows.
    // fit() reads the container's computed size which is only
    // reliable after layout — the layout ran during React's commit
    // phase before this useEffect fires, so we're safe.
    try {
      fit.fit()
      const { cols, rows } = term
      void window.api.resize(sessionId, cols, rows)
    } catch {
      // If the container has a zero dimension for some reason
      // (hidden tab, transient layout) fit() throws. The first
      // real ResizeObserver tick will recover.
    }

    // Outgoing: keystrokes typed into the xterm go straight to the
    // shell via sendInput. No slash mode, no history cycling, no
    // composer — this is a raw terminal.
    const onDataDisposable = term.onData(data => {
      void window.api.sendInput(sessionId, data)
    })

    // Incoming: raw bytes from the shell PTY. We subscribe ONCE at
    // mount; the handler filters by sessionId so multiple terminal
    // panes coexist without stomping on each other's output.
    const offTerminalData = window.api.onSessionTerminalData(
      ({ sessionId: sid, data }) => {
        if (sid !== sessionId) return
        term.write(data)
      },
    )

    // Container resize observer. Whenever the tile's cell area
    // changes size (split drag, window resize, tab activation), we
    // re-fit the terminal and push the new cols/rows down to the
    // shell so programs like `vim` / `htop` / `less` see the
    // correct dimensions.
    const resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit()
        const { cols, rows } = term
        void window.api.resize(sessionId, cols, rows)
      } catch {
        // Swallow transient-layout errors the same way we swallow
        // them in TerminalSession.resize() on the main side.
      }
    })
    resizeObserver.observe(container)

    return () => {
      resizeObserver.disconnect()
      onDataDisposable.dispose()
      offTerminalData()
      term.dispose()
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

      {/* xterm.js mounts here. We deliberately size it to fill the
          remaining flex cell; fit addon reads this container's
          dimensions to decide cols/rows. The bg-canvas token shows
          through xterm's transparent background, so themes work. */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 min-w-0 overflow-hidden p-2"
      />
    </div>
  )
}
