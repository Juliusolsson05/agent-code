import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

import { useAppStore } from '@renderer/app-state/hooks'
import {
  THEME_CHANGED_EVENT,
  getActiveAppFontFamily,
} from '@renderer/app-state/settings/theme'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionRuntime } from '@renderer/workspace/workspaceState'
import type { SessionId, SessionKind } from '@renderer/workspace/types'
import { shortenCwd } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import { PaneToast } from '@renderer/workspace/tile-tree/TileLeaf/PaneToast'
import { useComposerDictation } from '@renderer/workspace/tile-tree/TileLeaf/useComposerDictation'

type Props = {
  sessionId: SessionId
  paneLabel?: string
  focused: boolean
  onFocusRequest: () => void
  workspace: Workspace
  runtime: SessionRuntime
  projectDir: string | null
  provider: Exclude<SessionKind, 'terminal'>
}

// AgentTerminalLeaf — full-pane raw provider terminal for Claude/Codex agents.
//
// This is #247's productized version of the debug AgentInlineTerminal: same
// live provider process, same raw PTY byte stream, but mounted as the pane's
// primary surface instead of a small debug rail. It deliberately bypasses the
// Agent Code feed/composer stack. That is the recovery invariant: when feed
// ownership, queued prompts, condition modals, or markdown rendering are the
// broken part, this view talks straight to the provider TUI through xterm.
//
// It is NOT TerminalLeaf. TerminalLeaf owns a shell session whose only UI is
// xterm. This component is a temporary view over an agent session whose normal
// owner remains the structured feed; toggling back remounts TileLeaf against
// the same SessionRuntime and provider process.
export function AgentTerminalLeaf({
  sessionId,
  paneLabel,
  focused,
  onFocusRequest,
  workspace,
  runtime,
  projectDir,
  provider,
}: Props) {
  const dictationEnabled = useAppStore(state => state.settings.dictationEnabled)
  const dictationProvider = useAppStore(state => state.settings.dictationProvider)
  const dictationShortcut = useAppStore(state => state.settings.dictationShortcut)
  const acknowledgeSession = workspace.acknowledgeSession
  const acknowledgeSessionRef = useRef(acknowledgeSession)
  acknowledgeSessionRef.current = acknowledgeSession

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  useComposerDictation({
    enabled: dictationEnabled,
    focused,
    provider: dictationProvider,
    shortcut: dictationShortcut,
    sink: { kind: 'terminal', sessionId },
    onMessage: message => workspace.showPaneToast(sessionId, message),
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let term: Terminal | null = null
    let fit: FitAddon | null = null
    let onDataDisposable: { dispose(): void } | null = null
    let offPtyData: (() => void) | null = null
    let resizeObserver: ResizeObserver | null = null
    let resizeFrame: number | null = null
    let disposed = false
    let attachedBackfillDone = false
    let lastCols = 0
    let lastRows = 0
    const backlogQueue: string[] = []
    let onThemeChangedListener: ((e: Event) => void) | null = null

    const fitAndResizeBackend = () => {
      resizeFrame = null
      if (!term || !fit) return
      try {
        fit.fit()
        const { cols, rows } = term
        if (cols <= 0 || rows <= 0) return
        // WHY de-dupe cols/rows: the raw terminal owns provider PTY size while
        // mounted. ResizeObserver fires frequently during split drags, and
        // forwarding no-op dimensions makes Claude/Codex repaint needlessly
        // while the same byte stream is also feeding xterm.
        if (cols === lastCols && rows === lastRows) return
        lastCols = cols
        lastRows = rows
        void window.api.resize(sessionId, cols, rows)
      } catch {
        // Hidden/zero-sized panes can throw until layout settles. The next
        // observer tick or focus remount will retry with a measurable box.
      }
    }

    const scheduleFitAndResizeBackend = () => {
      if (resizeFrame !== null) return
      resizeFrame = requestAnimationFrame(fitAndResizeBackend)
    }

    try {
      term = new Terminal({
        cursorBlink: true,
        convertEol: false,
        fontFamily: getActiveAppFontFamily(),
        fontSize: 13,
        scrollback: 2000,
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      termRef.current = term

      scheduleFitAndResizeBackend()
      resizeObserver = new ResizeObserver(scheduleFitAndResizeBackend)
      resizeObserver.observe(container)

      onDataDisposable = term.onData(data => {
        acknowledgeSessionRef.current(sessionId)
        void window.api.sendInput(sessionId, data)
      })

      // Subscribe before attach, then replay the buffer before draining live
      // bytes. This mirrors TerminalLeaf's attach contract and prevents the
      // provider prompt/repaint that arrived before mount from being lost.
      offPtyData = window.api.onSessionAgentPtyData(({ sessionId: sid, data }) => {
        if (sid !== sessionId) return
        if (!attachedBackfillDone) {
          backlogQueue.push(data)
          // Attach should resolve quickly, but cap the pre-attach queue anyway
          // so an IPC stall during a noisy provider repaint cannot grow without
          // bound in the renderer.
          if (backlogQueue.length > 256) backlogQueue.splice(0, backlogQueue.length - 256)
          return
        }
        term?.write(data)
      })

      void window.api.attachAgentPty(sessionId).then(buffer => {
        if (disposed || termRef.current !== term) return
        const liveTerm = term
        if (!liveTerm) return
        if (buffer) liveTerm.write(buffer)
        if (backlogQueue.length > 0) liveTerm.write(backlogQueue.join(''))
        backlogQueue.length = 0
        attachedBackfillDone = true
        if (focusedRef.current) liveTerm.focus()
      })

      onThemeChangedListener = (): void => {
        if (term) term.options.fontFamily = getActiveAppFontFamily()
      }
      window.addEventListener(THEME_CHANGED_EVENT, onThemeChangedListener)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[AgentTerminalLeaf] xterm init failed:', err)
    }

    return () => {
      disposed = true
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
      resizeObserver?.disconnect()
      onDataDisposable?.dispose()
      offPtyData?.()
      if (onThemeChangedListener) {
        window.removeEventListener(THEME_CHANGED_EVENT, onThemeChangedListener)
      }
      void window.api.detachAgentPty(sessionId)
      term?.dispose()
      termRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (focused) termRef.current?.focus()
  }, [focused])

  const focusTerminal = () => {
    termRef.current?.focus()
  }

  return (
    <div
      data-pane-id={sessionId}
      className={`
        flex flex-col h-full min-h-0 min-w-0
        border ${focused ? 'border-accent' : 'border-border'}
        bg-canvas
      `}
      onMouseDown={() => {
        onFocusRequest()
        acknowledgeSession(sessionId)
        focusTerminal()
      }}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-1 border-b border-border bg-surface text-[10px] text-muted font-code select-none">
        <div className="flex items-center gap-2 min-w-0">
          {paneLabel && (
            <span className="flex-shrink-0 rounded-[3px] border border-current/30 px-1 leading-[14px] text-[9px] font-semibold tabular-nums">
              {paneLabel}
            </span>
          )}
          <span className="flex-shrink-0 text-ink">raw {provider}</span>
          <span className="truncate" title={projectDir ?? 'no project dir'}>
            {shortenCwd(projectDir)}
          </span>
        </div>
        <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted">
          terminal view
        </span>
      </div>

      <div className="flex-1 min-h-0 min-w-0 overflow-hidden p-2">
        <div
          ref={containerRef}
          className="h-full min-h-0 min-w-0 overflow-hidden relative"
        />
      </div>
      {/* WHY terminal mode still renders PaneToast:
        Pane toasts are runtime feedback from commands/actions, not a feed-only
        visual. Hybrid can legitimately fall back to AgentTerminalLeaf right
        after an action completes (for example Copy Assistant releases its
        picker lease before showing "Copied assistant message"). Without this
        shared slot, the action succeeds but the confirmation disappears with
        TileLeaf. */}
      <PaneToast message={runtime.paneToast} />
    </div>
  )
}
