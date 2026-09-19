import { useEffect, useRef } from 'react'
import { focusIsUnowned } from '@renderer/workspace/tile-tree/TileLeaf/useInteractiveOwnership'
import { useAgentTerminalOwnerVisible } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

import type { SessionId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useAppStore } from '@renderer/app-state/hooks'
import { PaneToast } from '@renderer/workspace/tile-tree/TileLeaf/PaneToast'
import { useComposerDictation } from '@renderer/workspace/tile-tree/TileLeaf/useComposerDictation'
import {
  THEME_CHANGED_EVENT,
  getActiveAppFontFamily,
} from '@renderer/app-state/settings/theme'
import { readXtermTheme, syncXtermTheme } from '@renderer/workspace/tile-tree/xtermTheme'
import { createTerminalInputForwarder } from '@renderer/workspace/tile-tree/terminalInputForwarder'
import { encodeTerminalPaste, registerTerminalPasteTarget } from '@renderer/workspace/terminal/textPasteTarget'
import { subscribeToTerminalData } from '@renderer/workspace/terminal/sessionDataDispatcher'
import { attachXtermWebglRenderer } from '@renderer/workspace/terminal/xtermWebglRenderer'
import { attachTerminalWheelBoundary } from '@renderer/workspace/terminal/terminalWheelBoundary'
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'
import { paneHeaderStatusLit } from '@renderer/workspace/tile-tree/TileLeaf/paneHeaderStatus'
import { useTerminalFollow } from '@renderer/workspace/tile-tree/terminalFollow'

// TerminalLeaf — one pane that hosts a plain shell session.
//
// Counterpart to TileLeaf. Where TileLeaf owns the elaborate agent UI (feed,
// composer, slash picker, …), TerminalLeaf is the minimal VS Code-style
// integrated terminal: one xterm.js instance under the SHARED pane header. No
// feed, no composer. Since #865 the header, title/name row, color flag,
// Status Mode fill and auto-follow are the same ones agents get; only
// transcript and composer features stay agent-only.
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
  /** The window's Status Mode setting. Required, not defaulted, mirroring
   *  #853's decision for AgentTerminalLeaf: an omitted prop is exactly how a
   *  header goes unlit by accident, and a default would let the next call
   *  site repeat that. */
  showStatusMode: boolean
}

export function TerminalLeaf({
  sessionId,
  paneLabel,
  focused,
  onFocusRequest,
  workspace,
  showStatusMode,
}: Props) {
  // Dictation target registration (issue #421). Plain terminal panes were the
  // ONE leaf kind that never called useComposerDictation, so a focused
  // terminal left the dictation-hotkey registry with zero focused targets and
  // pickTarget() fell back to the most-recently-focused AGENT composer — the
  // user pressed Fn over a terminal and the transcript landed in some other
  // tile. There is nothing terminal-hostile about dictation: the
  // `sink: 'terminal'` path (already proven by AgentTerminalLeaf) shows the
  // floating overlay and writes the final transcript to the PTY as plain
  // input bytes — no auto-submit, the user reviews and presses Enter.
  const dictationEnabled = useAppStore(state => state.settings.dictationEnabled)
  const dictationProvider = useAppStore(state => state.settings.dictationProvider)
  const dictationShortcut = useAppStore(state => state.settings.dictationShortcut)
  // Declared before the dictation hook so the registration below can gate on
  // it (hook order is call order; the visibility answer must exist first).
  const ownerVisible = useAgentTerminalOwnerVisible()
  useComposerDictation({
    // WHY both flags are visibility-gated (#757 round-4 review): this leaf
    // stays mounted (display:none) while Reader/Spotlight/Settings own the
    // screen, and the retained tree keeps focusedSessionId pointing at it.
    // The dictation registry prefers the focused target, so an ungated
    // registration meant the global Fn hotkey transcribed straight into
    // this INVISIBLE pane's PTY. Both siblings (TileLeaf, AgentTerminalLeaf)
    // already gate the same way; this was the one leaf kind that didn't.
    enabled: dictationEnabled && ownerVisible,
    focused: focused && ownerVisible,
    provider: dictationProvider,
    shortcut: dictationShortcut,
    sink: { kind: 'terminal', sessionId },
    onMessage: message => workspace.showPaneToast(sessionId, message),
  })

  // WHY this leaf renders a pane toast at all, and why it subscribes to the
  // STRING rather than taking the runtime as a prop:
  //
  // Plain terminal panes were the one leaf kind that called showPaneToast
  // (dictation at the top of this file, and the resume/backend messages
  // below) without ever rendering PaneToast, so every one of those messages
  // was written into the store and shown to nobody. #840 made that a dead
  // command rather than a missing nicety: it opened terminal panes up as
  // prompt-template and vault-key insertion targets, and routed ALL of that
  // feature's feedback — success, "pane is not ready", "target pane is gone" —
  // through showPaneToast. On a shell pane a failed insertion produced no
  // toast, and the palette does not close on failure, so nothing happened at
  // all.
  //
  // A primitive selector, not the whole runtime: this leaf deliberately does
  // not re-render on runtime ticks (the xterm instance owns its own output
  // path), and threading the runtime in as a prop would re-render it on every
  // PTY chunk. Subscribing to the toast string re-renders on exactly the one
  // transition that changes what is painted.
  // Optional chain on the MAP as well as the entry: several renderer specs and
  // the phone bundle mock the store with only the keys they use, and the
  // repository's standing rule is that a keyless store must degrade, never
  // throw (see agentNames/selectors.ts and PaneHeader.phoneCoupling).
  const paneToast = useAppStore(state => state.workspaceRuntimes?.[sessionId]?.paneToast ?? null)

  const acknowledgeSession = workspace.acknowledgeSession
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
  // Session metadata and activity as PRIMITIVE selectors (#865). This leaf
  // deliberately never takes the runtime as a prop: the xterm owns its output
  // path, and a runtime prop would re-render the leaf on every PTY chunk. Each
  // value below changes only on the transition that changes what is painted.
  const title = useAppStore(state => state.workspaceState?.sessions?.[sessionId]?.title)
  const spawnCwd = useAppStore(state => state.workspaceState?.sessions?.[sessionId]?.cwd ?? null)
  const liveCwd = useAppStore(state => state.workspaceRuntimes?.[sessionId]?.terminalForeground?.cwd ?? null)
  const foregroundCommand = useAppStore(state => {
    const foreground = state.workspaceRuntimes?.[sessionId]?.terminalForeground
    return foreground?.busy ? foreground.command : null
  })
  const isSessionLive = useAppStore(state => state.workspaceRuntimes?.[sessionId]?.sessionStatus === 'running')
  const tailMode = useAppStore(state => state.workspaceRuntimes?.[sessionId]?.tailMode === true)
  const tailAllMode = useAppStore(state => state.tailAllMode === true)
  const scrollToLatestRequest = useAppStore(state => state.workspaceRuntimes?.[sessionId]?.scrollToLatestRequest ?? 0)
  // Same mask AgentTerminalLeaf uses: a display:none pane cannot scroll, and
  // folding visibility in makes re-reveal a real transition that re-engages.
  const tailActive = (tailMode || tailAllMode) && ownerVisible
  // Must run BEFORE the mount effect below: its effects read termRef at effect
  // time and React runs passive effects in declaration order.
  const follow = useTerminalFollow({ sessionId, scrollToLatestRequest, tailActive, termRef })
  // WHY a shell pane tracks visibility itself (#752 review): agent panes get
  // their "may I measure / who owns the PTY size" answer from
  // MountedAgentTerminalOwner, which TerminalLeaf never had — a shell has no
  // inline debug twin to arbitrate with. But retention under display:none
  // gives it the same stale-size problem: Spotlight's copy resizes the PTY
  // to full width, and on reveal the retained leaf's fit equals its old
  // cols/rows, so the de-dupe swallows the resize the shell now needs.
  const ownerVisibleRef = useRef(ownerVisible)
  ownerVisibleRef.current = ownerVisible
  const onVisibilityChangeRef = useRef<((visible: boolean) => void) | null>(null)
  useEffect(() => {
    onVisibilityChangeRef.current?.(ownerVisible)
  }, [ownerVisible])
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
    let webglRenderer: ReturnType<typeof attachXtermWebglRenderer> | null = null
    let wheelBoundary: ReturnType<typeof attachTerminalWheelBoundary> | null = null
    let onDataDisposable: { dispose(): void } | null = null
    let offTerminalData: (() => void) | null = null
    // Nullable like the disposables above: xterm init can throw before the
    // follow wiring ever runs, and cleanup must survive that path.
    let offFollowAttach: (() => void) | null = null
    let offTextPaste: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null
    let resizeFrame: number | null = null
    let disposed = false
    let attachedBackfillDone = false
    let lastCols = 0
    let lastRows = 0
    let pendingResize: { cols: number; rows: number } | null = null
    const pendingInput: string[] = []
    // Tracked here (not inside the try block) so cleanup can detach
    // the global event listener whether mount succeeded or failed
    // before the listener was attached.
    let onThemeChangedListenerRef: ((e: Event) => void) | null = null

    const sendResizeIfChanged = (cols: number, rows: number) => {
      if (cols === lastCols && rows === lastRows) return
      lastCols = cols
      lastRows = rows
      void window.api.resize(sessionId, cols, rows)
    }

    const fitAndNotifyResize = () => {
      resizeFrame = null
      if (!term || !fit) return
      // A display:none box measures as nothing; FitAddon's NaN guard would
      // catch it, but never even asking keeps the guard from being the only
      // thing between a hidden pane and a 2×1 resize on a live shell.
      if (!ownerVisibleRef.current) return
      try {
        fit.fit()
        const { cols, rows } = term
        // Matches AgentTerminalLeaf: a degenerate grid must never reach the
        // PTY. FitAddon's own isNaN guard covers the display:none case, so
        // this is belt-and-braces rather than a known live bug — but these
        // two files are otherwise line-for-line parallel and the asymmetry
        // reads as one of them being wrong.
        if (cols <= 0 || rows <= 0) return
        // WHY guard by integer cols/rows: ResizeObserver can fire many times
        // during split drag while xterm's grid dimensions stay unchanged.
        // Sending every observer tick through IPC makes node-pty process a
        // stream of resize no-ops and multiplies the layout-drag cost across
        // every terminal pane.
        if (!attachedBackfillDone) {
          // WHY queue instead of sending early: after restart, terminal panes can
          // mount while ensureSessionLive is still recreating the backend. Main
          // returns false for resize/input before the RegistryEntry exists, and
          // recording lastCols/lastRows at that point would suppress the exact
          // size the newly attached PTY needs. Keep only the latest size; once
          // attach succeeds, replay it through the normal de-duped path.
          pendingResize = { cols, rows }
          return
        }
        sendResizeIfChanged(cols, rows)
      } catch {
        // Zero-dimension containers still throw. A later observer tick will
        // recover when layout produces a measurable terminal box.
      }
    }

    const scheduleFitAndNotifyResize = () => {
      if (resizeFrame !== null) return
      resizeFrame = requestAnimationFrame(fitAndNotifyResize)
    }

    onVisibilityChangeRef.current = visible => {
      if (!visible) {
        // Mirror AgentTerminalLeaf's ownership loss: whatever size we last
        // sent no longer describes the PTY once another leaf (Spotlight's)
        // may have resized it, and a queued measurement must not replay.
        pendingResize = null
        lastCols = 0
        lastRows = 0
        if (resizeFrame !== null) {
          cancelAnimationFrame(resizeFrame)
          resizeFrame = null
        }
        return
      }
      scheduleFitAndNotifyResize()
    }

    try {
      // WHY theme xterm explicitly: xterm renders its own canvas-ish DOM tree
      // and does not inherit the surrounding Tailwind tokens. Leaving the
      // default terminal theme alone was acceptable while the app was dark
      // only, but it turns every shell pane into a black island in light mode.
      // readXtermTheme keeps the app-owned foreground/background/cursor tied
      // to CSS variables while preserving a stable ANSI table for shell tools.
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
        theme: readXtermTheme(),
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      // Host-level, after open(): bubbles after every xterm wheel listener so
      // xterm keeps first refusal — see terminalWheelBoundary.ts.
      wheelBoundary = attachTerminalWheelBoundary(container)
      // Renderer changes (DOM -> WebGL, or back after a context loss) change
      // cell metrics without resizing the container, so the ResizeObserver
      // would never refit them; see XtermWebglRendererOptions.onRendererChange.
      webglRenderer = attachXtermWebglRenderer(term, { onRendererChange: scheduleFitAndNotifyResize })
      termRef.current = term
      fitRef.current = fit
      // Follow re-pin wiring lives in the hook; the mount effect only owns
      // the terminal instance lifetime, so this attaches/detaches with it.
      offFollowAttach = follow.attach(term)

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
      // Replay-aware, coalescing outgoing path — see terminalInputForwarder.ts
      // (#745). A shell replay carries fewer terminal queries than an agent
      // TUI's, but the same stale-reply hazard applies.
      const forwarder = createTerminalInputForwarder(data => {
        void window.api.sendInput(sessionId, data)
      })
      offTextPaste = registerTerminalPasteTarget(sessionId, {
        isActive: () => !disposed && focusedRef.current && ownerVisibleRef.current,
        paste: async text => {
          if (disposed || !ownerVisibleRef.current || !attachedBackfillDone || forwarder.replaying || !term) return false
          return window.api.sendInput(sessionId, encodeTerminalPaste(text, term.modes.bracketedPasteMode))
        },
      })
      onDataDisposable = term.onData(data => {
        if (forwarder.replaying) return
        if (!attachedBackfillDone) {
          pendingInput.push(data)
          // A held key during restart wake should not grow without bound if the
          // backend fails to attach. Keep the tail; terminal input is inherently
          // sequential and the most recent bytes are the only useful recovery
          // signal once the user sees the pane still waking.
          if (pendingInput.length > 256) pendingInput.splice(0, pendingInput.length - 256)
          return
        }
        forwarder.onData(data)
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
      const backlogQueue: string[] = []
      offTerminalData = subscribeToTerminalData(sessionId, data => {
        if (!attachedBackfillDone) {
          backlogQueue.push(data)
          return
        }
        const liveTerm = term
        if (follow.tailActiveRef.current) {
          // Scroll in the write-completion callback: xterm parses chunks
          // asynchronously, so a synchronous scroll lands one chunk early.
          // Re-check at fire time: tail can disengage or the pane unmount first.
          liveTerm?.write(data, () => {
            if (disposed || !follow.tailActiveRef.current) return
            liveTerm.scrollToBottom()
          })
        } else {
          liveTerm?.write(data)
        }
      })
      // WHY wake uses callback refs instead of making workspace an effect
      // dependency: this effect owns xterm's lifetime. The workspace object is
      // rebuilt for ordinary renderer state changes, but the shell attachment
      // should only remount when its session id changes. Re-running this effect
      // for helper identity churn would destroy scrollback and re-open the
      // attach race that the subscribe/attach/drain sequence below exists to
      // avoid.
      void ensureSessionLiveRef.current(sessionId, 'terminal-leaf.mount')
        .then(() => {
          if (disposed || termRef.current !== term) return null
          return window.api.attachTerminal(sessionId)
        })
        .then(buffer => {
          if (buffer === null) return
          // The cleanup below may have disposed the term already
          // (transient remount, rapid tab switch). Check before
          // touching it.
          if (disposed || termRef.current !== term) return
          const liveTerm = term
          if (!liveTerm) return
          // Replay the buffer, then drain any live events that arrived
          // between subscribe and attach-response. These are strictly AFTER
          // the buffer's last byte because main buffered silently until we
          // called attach. The forwarder drops whatever xterm answers while
          // parsing either.
          forwarder
            .replay(liveTerm, [buffer, backlogQueue.join('')])
            .then(() => {
              // Pin once the backfill is really parsed, not before it lands.
              if (disposed || !follow.tailActiveRef.current || termRef.current !== liveTerm) return
              liveTerm.scrollToBottom()
            })
            .catch(error => {
              if (!disposed) showPaneToastRef.current(sessionId,
                error instanceof Error ? error.message : 'Could not replay terminal')
            })
          backlogQueue.length = 0
          attachedBackfillDone = true
          if (pendingResize) {
            sendResizeIfChanged(pendingResize.cols, pendingResize.rows)
            pendingResize = null
          }
          if (pendingInput.length > 0) {
            void window.api.sendInput(sessionId, pendingInput.join(''))
            pendingInput.length = 0
          }
          // Now that content has landed, force-focus the terminal
          // so the very first keystroke the user makes lands in
          // xterm. The focus-on-mount effect above already called
          // focus() once, but the attach replay can take a moment
          // (IPC round trip + first paint) and during that window
          // focus might have drifted to somewhere else — this
          // re-focus closes the gap if the pane is still the
          // workspace-focused one.
          if (focusedRef.current && ownerVisibleRef.current) liveTerm.focus()
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
        if (!term) return
        term.options.fontFamily = getActiveAppFontFamily()
        syncXtermTheme(term)
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
      disposed = true
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      resizeObserver?.disconnect()
      onDataDisposable?.dispose()
      offTerminalData?.()
      offFollowAttach?.()
      offTextPaste?.()
      webglRenderer?.dispose()
      wheelBoundary?.dispose()
      if (onThemeChangedListenerRef) {
        window.removeEventListener(THEME_CHANGED_EVENT, onThemeChangedListenerRef)
      }
      term?.dispose()
      termRef.current = null
      onVisibilityChangeRef.current = null
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
  const prevFocusedRef = useRef(focused)
  useEffect(() => {
    const focusChanged = prevFocusedRef.current !== focused
    prevFocusedRef.current = focused
    if (!focused || !ownerVisible) return
    // On a reveal only take an unowned focus (see focusIsUnowned): editor-
    // fullscreen exit must leave the caret in Monaco.
    if (focusChanged || focusIsUnowned()) termRef.current?.focus()
  }, [focused, ownerVisible])

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

  // PaneHeader's own rule, so the badge/TAIL colors can never disagree with
  // the fill they sit on (same reason as AgentTerminalLeaf).
  const statusLit = paneHeaderStatusLit(showStatusMode, isSessionLive)

  return (
    <div
      // data-pane-id: agents.show, the HTML debug capture and the debug
      // bundle locate panes by it; plain terminals were the one leaf without it.
      data-pane-id={sessionId}
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
      // xterm's onData also carries automatic protocol responses. A shell
      // querying its cursor must neither clear unread state nor schedule React
      // work. DOM capture attributes engagement without guessing from bytes
      // and runs even when xterm stops the keyboard event from bubbling.
      onKeyDownCapture={() => acknowledgeSession(sessionId)}
      onPasteCapture={() => acknowledgeSession(sessionId)}
      onCompositionEndCapture={() => acknowledgeSession(sessionId)}
    >
      {/* The shared header, not a copy (#865). The old hand-drawn strip
          predated every header feature and received none of them: no cwd,
          no color flag, no title/name row, no Status Mode fill. #851 was the
          same drift in AgentTerminalLeaf. Terminal chrome goes in via slots. */}
      <PaneHeader
        sessionId={sessionId}
        paneLabel={paneLabel}
        agentTitle={title}
        // runtime.projectDir is always undefined for shells (main emits
        // started without one). The live tmux cwd follows `cd`; the spawn
        // cwd is the fallback for direct PTYs and before the first sample.
        projectDir={liveCwd ?? spawnCwd}
        statusMode={showStatusMode}
        isSessionLive={isSessionLive}
        badge={
          <span className={`flex-shrink-0 ${statusLit ? '' : 'text-ink'}`}>
            {foregroundCommand ?? 'terminal'}
          </span>
        }
        trailing={tailActive ? (
          <span className={`text-[10px] font-code uppercase tracking-wider ${statusLit ? '' : 'text-accent'}`}>
            TAIL
          </span>
        ) : null}
      />

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
      {/* Same slot and ordering as AgentTerminalLeaf: below the terminal box.
          Note what this DOES cost, since the obvious reading is wrong — the
          slot is a non-shrinking flex sibling, so while a toast is on screen
          the xterm box really is shorter, its ResizeObserver fires, and the
          PTY is resized down and then back up when the toast clears. That is
          the same shape as AgentTerminalLeaf and is accepted for the same
          reason: pane feedback that is never rendered is worse than a
          transient reflow. It is also why the toast lives here rather than
          overlaying the terminal, where it would hide output. */}
      <PaneToast message={paneToast} />
    </div>
  )
}
