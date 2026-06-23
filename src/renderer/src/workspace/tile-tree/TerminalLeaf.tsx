import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import {
  THEME_CHANGED_EVENT,
  getActiveAppFontFamily,
} from '@renderer/app-state/settings/theme'

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
  paneLabel?: string
  focused: boolean
  onFocusRequest: () => void
  workspace: Workspace
}

export function TerminalLeaf({
  sessionId,
  paneLabel,
  focused,
  onFocusRequest,
  workspace,
}: Props) {
  const acknowledgeSession = workspace.acknowledgeSession
  // WHY this is a ref instead of an effect dependency: the effect below owns
  // the xterm instance and its PTY subscriptions. Re-running it for a helper
  // identity change would tear down scrollback and re-arm attach races even
  // though the terminal session itself did not change. The session id is the
  // real lifecycle boundary; the ref lets the data handler call the latest
  // acknowledgement function without making helper identity part of xterm's
  // mount/unmount contract.
  const acknowledgeSessionRef = useRef(acknowledgeSession)
  acknowledgeSessionRef.current = acknowledgeSession
  const ensureSessionLiveRef = useRef(workspace.ensureSessionLive)
  ensureSessionLiveRef.current = workspace.ensureSessionLive
  const showPaneToastRef = useRef(workspace.showPaneToast)
  showPaneToastRef.current = workspace.showPaneToast
  // The DOM node xterm.js renders into. We give it a fresh ref on
  // every mount; xterm's open() attaches on top.
  const containerRef = useRef<HTMLDivElement>(null)
  // The xterm instance itself. Kept in a ref so the effects below
  // can access it without triggering re-renders on every data tick.
  const termRef = useRef<Terminal | null>(null)
  const focusedRef = useRef(focused)
  focusedRef.current = focused
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
    let resizeFrame: number | null = null
    let lastCols = 0
    let lastRows = 0
    // Tracked here (not inside the try block) so cleanup can detach
    // the global event listener whether mount succeeded or failed
    // before the listener was attached.
    let onThemeChangedListenerRef: ((e: Event) => void) | null = null

    const fitAndNotifyResize = () => {
      resizeFrame = null
      if (!term || !fit) return
      try {
        fit.fit()
        const { cols, rows } = term
        // WHY guard by integer cols/rows: ResizeObserver can fire many times
        // during split drag while xterm's grid dimensions stay unchanged.
        // Sending every observer tick through IPC makes node-pty process a
        // stream of resize no-ops and multiplies the layout-drag cost across
        // every terminal pane.
        if (cols === lastCols && rows === lastRows) return
        lastCols = cols
        lastRows = rows
        void window.api.resize(sessionId, cols, rows)
      } catch {
        // Zero-dimension containers still throw. A later observer tick will
        // recover when layout produces a measurable terminal box.
      }
    }

    const scheduleFitAndNotifyResize = () => {
      if (resizeFrame !== null) return
      resizeFrame = requestAnimationFrame(fitAndNotifyResize)
    }

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
        // Pull the user-picked font from the central settings layer.
        // xterm.js renders to a canvas, so it cannot read the
        // `--theme-app-font` CSS variable directly — getActiveAppFontFamily
        // reads the variable's computed value (which applyTheme keeps in
        // sync with `settings.fontFamily`) and returns a complete CSS
        // font-family declaration including fallback chain. The live
        // event listener below keeps this in sync if the user changes
        // the font while the terminal is mounted.
        fontFamily: getActiveAppFontFamily(),
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
      scheduleFitAndNotifyResize()

      // Outgoing: keystrokes typed into the xterm go straight to
      // the shell via sendInput. No slash mode, no history
      // cycling, no composer — this is a raw terminal.
      onDataDisposable = term.onData(data => {
        acknowledgeSessionRef.current(sessionId)
        void window.api.sendInput(sessionId, data)
      })

      // Incoming: raw bytes from the shell PTY.
      //
      // The subscribe+attach+drain dance below fixes the
      // "missed prompt" race. Sequence:
      //
      //   1. Subscribe to 'session:terminal-data' FIRST. Any live
      //      events main broadcasts from this point forward
      //      arrive at our handler — but until the attach
      //      response lands, main hasn't flipped its attached
      //      flag so no live events are actually broadcast. The
      //      subscription is harmless-but-ready.
      //
      //   2. Call attachTerminal(sessionId). Main atomically
      //      returns the full buffered output so far AND flips
      //      the attached flag in the same synchronous block, so
      //      no PTY bytes can be lost between the read and the
      //      flag flip.
      //
      //   3. Between the attach IPC send and its response, main
      //      may begin broadcasting live events (because the
      //      attached flag was flipped). Our live handler queues
      //      them into `backlogQueue` instead of writing them to
      //      xterm — we don't want them appearing before the
      //      buffer.
      //
      //   4. When attach resolves, write the buffer to xterm
      //      first, then drain the queue, then flip the flag so
      //      future events write directly.
      //
      // Without this sequence, the shell's initial prompt (which
      // fires BEFORE the renderer even mounts TerminalLeaf) is
      // silently dropped and the user sees a blank terminal with
      // just a blinking cursor. Exactly the bug reported.
      let attachedBackfillDone = false
      const backlogQueue: string[] = []
      offTerminalData = window.api.onSessionTerminalData(
        ({ sessionId: sid, data }) => {
          if (sid !== sessionId) return
          if (!attachedBackfillDone) {
            backlogQueue.push(data)
            return
          }
          term?.write(data)
        },
      )
      // WHY wake uses callback refs instead of making workspace an effect
      // dependency: this effect owns xterm's lifetime. The workspace object is
      // rebuilt for ordinary renderer state changes, but the shell attachment
      // should only remount when its session id changes. Re-running this effect
      // for helper identity churn would destroy scrollback and re-open the
      // attach race that the subscribe/attach/drain sequence below exists to
      // avoid.
      void ensureSessionLiveRef.current(sessionId)
        .then(() => window.api.attachTerminal(sessionId))
        .then(buffer => {
          // The cleanup below may have disposed the term already
          // (transient remount, rapid tab switch). Check before
          // touching it.
          if (!termRef.current) return
          if (buffer) termRef.current.write(buffer)
          // Drain any live events that arrived between subscribe
          // and attach-response. These are strictly AFTER the
          // buffer's last byte because main buffered silently
          // until we called attach.
          if (backlogQueue.length > 0) termRef.current.write(backlogQueue.join(''))
          backlogQueue.length = 0
          attachedBackfillDone = true
          // Now that content has landed, force-focus the terminal
          // so the very first keystroke the user makes lands in
          // xterm. The focus-on-mount effect above already called
          // focus() once, but the attach replay can take a moment
          // (IPC round trip + first paint) and during that window
          // focus might have drifted to somewhere else — this
          // re-focus closes the gap if the pane is still the
          // workspace-focused one.
          if (focusedRef.current) termRef.current.focus()
        })
        .catch(err => {
          showPaneToastRef.current(
            sessionId,
            err instanceof Error && err.message.length > 0
              ? err.message
              : 'Could not wake terminal',
          )
        })

      // Container resize observer. Whenever the tile's cell area
      // changes size (split drag, window resize, tab activation),
      // we re-fit the terminal and push the new cols/rows down to
      // the shell so programs like `vim` / `htop` / `less` see
      // the correct dimensions.
      resizeObserver = new ResizeObserver(scheduleFitAndNotifyResize)
      resizeObserver.observe(container)

      // Live-update the xterm fontFamily when the user changes the
      // global font setting. applyTheme dispatches THEME_CHANGED_EVENT
      // AFTER mutating the CSS variable, so re-reading via
      // getActiveAppFontFamily here always sees the new value.
      // xterm.js exposes `term.options.fontFamily` as a setter that
      // triggers an internal re-measure + re-render — no manual fit
      // needed because the cell-size change is what fit() responds to
      // and the existing ResizeObserver covers any container resize
      // that follows.
      const onThemeChanged = (): void => {
        if (term) term.options.fontFamily = getActiveAppFontFamily()
      }
      window.addEventListener(THEME_CHANGED_EVENT, onThemeChanged)
      // Capture the handler reference for the cleanup return below.
      // We assign through the outer closure rather than a new local
      // because the existing return () runs after this try block.
      onThemeChangedListenerRef = onThemeChanged
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
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      resizeObserver?.disconnect()
      onDataDisposable?.dispose()
      offTerminalData?.()
      if (onThemeChangedListenerRef) {
        window.removeEventListener(THEME_CHANGED_EVENT, onThemeChangedListenerRef)
      }
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
  //
  // This effect only fires when `focused` *changes* — it doesn't
  // help when DOM focus drifts away while the pane is already
  // focused at the workspace level. For that we have the
  // synchronous `focusTerminal()` handler below, wired into the
  // outer div's onMouseDown.
  useEffect(() => {
    if (focused) termRef.current?.focus()
  }, [focused])

  // Imperative re-focus. Called from outer-div mousedown so that
  // ANY click inside the terminal pane re-focuses xterm's helper
  // textarea synchronously, even when the workspace-level
  // `focused` prop hasn't changed.
  //
  // Root cause for why this is load-bearing: the user reported
  // backspace working "about half the time". Symptom was a focus
  // drift — DOM focus could wander off xterm (browser clicks, app
  // switch, some invisible element grabbing focus) without our
  // React state catching it, so some keystrokes hit xterm and
  // others were dropped by the browser since xterm's hidden
  // textarea wasn't the activeElement. Wiring a direct focus call
  // on every click inside the pane closes the gap — if the user
  // is clicking or typing here, they want xterm to have focus,
  // period.
  const focusTerminal = () => {
    termRef.current?.focus()
  }

  return (
    <div
      className={`
        flex flex-col h-full min-h-0 min-w-0
        border ${focused ? 'border-accent' : 'border-border'}
        bg-canvas
      `}
      // Two things happen on mousedown inside this pane:
      //   1. onFocusRequest lets the workspace know this pane is
      //      now the active one (updates workspace.focusedSessionId
      //      and the useKeybinds router).
      //   2. focusTerminal synchronously focuses xterm's hidden
      //      textarea so the very next keystroke lands in the
      //      terminal. Without step 2, DOM focus could still be
      //      wherever it drifted to (see focusTerminal's block
      //      comment above for the backspace-half-the-time bug).
      //      The React `focused` prop might already be true if the
      //      pane was already "workspace-focused", so the
      //      useEffect-based refocus below won't re-fire; this is
      //      the synchronous safety net.
      onMouseDown={() => {
        onFocusRequest()
        acknowledgeSession(sessionId)
        focusTerminal()
      }}
    >
      {/* Compact header to match TileLeaf's status strip so a
          mixed layout doesn't look ragged. We don't have CC-style
          live state to show, so just a static "terminal" label. */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-border bg-surface text-[10px] text-muted font-code select-none">
        <div className="flex items-center gap-2 min-w-0">
          {paneLabel && (
            <span className="flex-shrink-0 rounded-[3px] border border-current/30 px-1 leading-[14px] text-[9px] font-semibold tabular-nums">
              {paneLabel}
            </span>
          )}
          <span>terminal</span>
        </div>
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
