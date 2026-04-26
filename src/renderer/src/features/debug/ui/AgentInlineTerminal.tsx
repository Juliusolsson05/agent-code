import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

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

export function AgentInlineTerminal({ sessionId, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let onDataDisposable: { dispose(): void } | null = null
    let offPtyData: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null
    let rafId: number | null = null
    let disposed = false

    try {
      term = new Terminal({
        cursorBlink: true,
        convertEol: false,
        fontFamily:
          '"JetBrains Mono", ui-monospace, Menlo, Monaco, monospace',
        fontSize: 10,
        scrollback: 2000,
        theme: {
          background: '#080808',
        },
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      termRef.current = term

      const fitAndResizeBackend = () => {
        if (!term || !fit) return
        try {
          fit.fit()
          const { cols, rows } = term
          if (cols > 0 && rows > 0) {
            void window.api.resize(sessionId, cols, rows)
          }
        } catch {
          // Hidden or zero-sized debug rails can briefly throw while
          // React is mounting/unmounting panels. The next observer tick
          // or manual panel reopen gives xterm a real box again.
        }
      }

      rafId = window.requestAnimationFrame(fitAndResizeBackend)
      resizeObserver = new ResizeObserver(fitAndResizeBackend)
      resizeObserver.observe(container)

      onDataDisposable = term.onData(data => {
        void window.api.sendInput(sessionId, data)
      })

      let attachedBackfillDone = false
      const backlogQueue: string[] = []
      offPtyData = window.api.onSessionAgentPtyData(({ sessionId: sid, data }) => {
        if (sid !== sessionId) return
        if (!attachedBackfillDone) {
          backlogQueue.push(data)
          return
        }
        term?.write(data)
      })

      void window.api.attachAgentPty(sessionId).then(buffer => {
        if (disposed || termRef.current !== term) return
        if (buffer) term.write(buffer)
        for (const d of backlogQueue) term.write(d)
        backlogQueue.length = 0
        attachedBackfillDone = true
        term.focus()
      })
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
      void window.api.detachAgentPty(sessionId)
      term?.dispose()
      termRef.current = null
    }
  }, [active, sessionId])

  return (
    <div
      className="
        h-[260px] min-h-[180px] w-full
        border border-[#222] bg-[#080808]
        overflow-hidden relative
      "
      onMouseDown={() => termRef.current?.focus()}
    >
      <div ref={containerRef} className="h-full w-full overflow-hidden relative" />
    </div>
  )
}
