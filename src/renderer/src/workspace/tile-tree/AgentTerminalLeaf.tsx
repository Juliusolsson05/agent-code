import { useEffect, useLayoutEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

import { useAppStore } from '@renderer/app-state/hooks'
import {
  THEME_CHANGED_EVENT,
  getActiveAppFontFamily,
} from '@renderer/app-state/settings/theme'
import { readXtermTheme, syncXtermTheme } from '@renderer/workspace/tile-tree/xtermTheme'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId, SessionKind } from '@renderer/workspace/types'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'
import { shortenCwd } from '@renderer/workspace/tile-tree/TileLeaf/labels'
import { PaneToast } from '@renderer/workspace/tile-tree/TileLeaf/PaneToast'
import { useComposerDictation } from '@renderer/workspace/tile-tree/TileLeaf/useComposerDictation'
import { useAgentTerminalDimensionActive } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import { AgentTitleHeader } from '@renderer/workspace/tile-tree/AgentTitleHeader'
import { createTerminalInputForwarder } from '@renderer/workspace/tile-tree/terminalInputForwarder'

type Props = {
  sessionId: SessionId
  paneLabel?: string
  agentTitle?: string
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
  agentTitle,
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
  const ensureSessionLiveRef = useRef(workspace.ensureSessionLive)
  ensureSessionLiveRef.current = workspace.ensureSessionLive
  // The mount effect is keyed on sessionId alone (see its WHY comment), so it
  // must read runtime state through a ref rather than closing over the prop.
  const runtimeRef = useRef(runtime)
  runtimeRef.current = runtime
  const showPaneToastRef = useRef(workspace.showPaneToast)
  showPaneToastRef.current = workspace.showPaneToast

  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const dimensionActive = useAgentTerminalDimensionActive()
  const dimensionActiveRef = useRef(false)
  const dimensionOwnershipEpochRef = useRef(0)
  const onDimensionOwnershipChangeRef = useRef<((active: boolean) => void) | null>(null)

  useLayoutEffect(() => {
    // WHY the terminal receives ownership as an imperative fence as well as a
    // hidden ancestor: asynchronous attach/ResizeObserver callbacks outlive the
    // render that scheduled them. A delayed attach can otherwise replay a
    // measurement captured before Global Editor fullscreen released ownership.
    // Incrementing the epoch invalidates queued measurements across both loss
    // and reacquisition, even if the component itself remains mounted.
    dimensionActiveRef.current = dimensionActive
    dimensionOwnershipEpochRef.current += 1
    onDimensionOwnershipChangeRef.current?.(dimensionActive)
  }, [dimensionActive])

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
    // Did this instance's attach actually land? `attachAgentPty` is
    // refcounted in main, and the cleanup below used to detach
    // unconditionally — including when no attach was ever issued because the
    // wake was still in flight.
    //
    // That unmatched detach cannot hurt the Spotlight remount case: React
    // runs a deleted subtree's passive cleanups BEFORE the new subtree's
    // passive effects, so the outgoing leaf always detaches before the
    // incoming one attaches. It hurts a CONCURRENT second consumer instead —
    // the debug panel's inline terminal on the same session, or two panes
    // rendering the same session through grid-related tabs. Count 1, an
    // unmatched detach deletes the key, and the still-mounted consumer loses
    // its agent-pty-data forwarding while the restore-resize fires against a
    // terminal the user is actively looking at. That is precisely the
    // multi-consumer case the refcount was introduced for (see
    // SessionManager.attachAgentPty's doc comment).
    let attached = false
    let attachedBackfillDone = false
    let lastCols = 0
    let lastRows = 0
    let pendingResize: { cols: number; rows: number; ownershipEpoch: number } | null = null
    const pendingInput: string[] = []
    const backlogQueue: string[] = []
    let onThemeChangedListener: ((e: Event) => void) | null = null

    const sendResizeIfChanged = (cols: number, rows: number) => {
      // Visibility is not merely a measurement concern. This is the last
      // writer-side fence before the singular provider PTY size changes, so it
      // also protects delayed attach replay and callbacks already queued when
      // ownership was released.
      if (!dimensionActiveRef.current) return
      if (cols === lastCols && rows === lastRows) return
      lastCols = cols
      lastRows = rows
      void window.api.resize(sessionId, cols, rows)
    }

    const fitAndResizeBackend = () => {
      resizeFrame = null
      if (!dimensionActiveRef.current) {
        pendingResize = null
        return
      }
      if (!term || !fit) return
      try {
        fit.fit()
        const { cols, rows } = term
        if (cols <= 0 || rows <= 0) return
        // WHY de-dupe cols/rows: the raw terminal owns provider PTY size while
        // mounted. ResizeObserver fires frequently during split drags, and
        // forwarding no-op dimensions makes Claude/Codex repaint needlessly
        // while the same byte stream is also feeding xterm.
        if (!attachedBackfillDone) {
          // WHY queue instead of sending early: lazy wake intentionally leaves
          // restored agents without a main-process RegistryEntry until attach or
          // send asks for one. Resize before attach can therefore be rejected,
          // and remembering those cols/rows as "sent" would prevent the real PTY
          // from receiving its first size. Preserve only the latest measurement
          // and replay it once attach confirms the backend exists.
          pendingResize = {
            cols,
            rows,
            ownershipEpoch: dimensionOwnershipEpochRef.current,
          }
          return
        }
        sendResizeIfChanged(cols, rows)
      } catch {
        // Hidden/zero-sized panes can throw until layout settles. The next
        // observer tick or focus remount will retry with a measurable box.
      }
    }

    const scheduleFitAndResizeBackend = () => {
      if (!dimensionActiveRef.current) return
      if (resizeFrame !== null) return
      resizeFrame = requestAnimationFrame(fitAndResizeBackend)
    }

    onDimensionOwnershipChangeRef.current = active => {
      if (!active) {
        // WHY reset both queued and sent state: while this pane is inactive the
        // inline terminal may resize the backend to a different viewport. A
        // stale pending measurement must never replay, and lastCols/lastRows no
        // longer describe backend truth even if this pane returns at the same
        // size it had before the takeover.
        pendingResize = null
        lastCols = 0
        lastRows = 0
        if (resizeFrame !== null) {
          cancelAnimationFrame(resizeFrame)
          resizeFrame = null
        }
        return
      }

      // Reacquisition always measures the current container. It cannot reuse a
      // pre-takeover value because another legitimate owner may have changed
      // the singular backend dimensions while this retained xterm was hidden.
      scheduleFitAndResizeBackend()
    }

    try {
      term = new Terminal({
        cursorBlink: true,
        convertEol: false,
        fontFamily: getActiveAppFontFamily(),
        fontSize: 13,
        scrollback: 2000,
        theme: readXtermTheme(),
      })
      fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      termRef.current = term

      if (dimensionActiveRef.current) scheduleFitAndResizeBackend()
      resizeObserver = new ResizeObserver(scheduleFitAndResizeBackend)
      resizeObserver.observe(container)

      // Replay-aware, coalescing outgoing path — see terminalInputForwarder.ts
      // (#745) for why replies xterm generates while parsing the replay must
      // never reach the provider and why same-tick chunks share one IPC call.
      const forwarder = createTerminalInputForwarder(data => {
        void window.api.sendInput(sessionId, data)
      })
      onDataDisposable = term.onData(data => {
        // A reply to replayed content is not user activity: no acknowledgement.
        if (forwarder.replaying) return
        acknowledgeSessionRef.current(sessionId)
        if (!attachedBackfillDone) {
          pendingInput.push(data)
          // Holding a key while an agent terminal is waking should not turn an
          // unavailable backend into an unbounded renderer buffer. Keep the most
          // recent input bytes; if wake fails the pane toast explains the failure
          // and the queue dies with this mount.
          if (pendingInput.length > 256) pendingInput.splice(0, pendingInput.length - 256)
          return
        }
        forwarder.onData(data)
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

      // WHY this goes through refs instead of effect deps: mounting xterm is
      // the expensive lifecycle boundary here. The workspace object is rebuilt
      // as renderer state changes, but those helper identity changes should not
      // tear down the raw PTY view, lose scrollback, and re-run attach. The
      // session id is the actual attachment identity; refs keep the wake/toast
      // callbacks current without making them part of xterm's mount contract.
      //
      // WHY the wake is conditional (#596): this effect runs on every MOUNT,
      // and this component is unmounted and remounted constantly — entering
      // and leaving Spotlight/Reader/Settings (which render outside
      // GlobalEditorShell, so the whole tile tree goes away), and on every tab
      // switch. Waking unconditionally meant each of those round-tripped
      // through recoverSession for an agent that was already running, flapped
      // its runtime status spawning→started, and — until the companion fix in
      // ensureSessionLive — armed a 30-second timer that KILLED the live
      // process.
      //
      // This is close to TileLeaf.send but deliberately NOT identical: that
      // one also wakes on `!runtime.inputReady`, which here would reinstate
      // the bug outright. In terminal mode "not ready" is the ordinary state
      // — the user is typing into the TUI or answering a permission prompt —
      // so readiness says nothing about whether a backend exists.
      //
      // `runtimeRef` (not `runtime`) because this effect must stay keyed on
      // sessionId alone.
      const needsWake =
        runtimeRef.current.processStatus !== 'started' || isSessionExited(runtimeRef.current)

      // Attach is attempted FIRST, before and independently of the wake.
      //
      // It used to be chained behind it, and that ordering was the reason the
      // 30s readiness timeout in ensureSessionLive was not merely possible but
      // GUARANTEED: with the attach pending, this terminal showed nothing, so
      // a user facing a trust or permission prompt could not answer the very
      // prompt that was holding readiness false. The timer then killed the
      // process, Retry respawned it into the same prompt, and the pane looped.
      // Showing the TUI immediately is what breaks that circle — readiness
      // does get re-published the moment the user answers (publishPromptGate
      // emits on every transition into ready), so the wait resolves normally.
      //
      // Attaching before the backend exists is free and safe: main returns
      // null without taking a reference, so we simply try again once the wake
      // has produced one.
      const tryAttach = async (): Promise<boolean> => {
        if (disposed || termRef.current !== term) return false
        const buffer = await window.api.attachAgentPty(sessionId)
        if (buffer === null) return false
        // Main took the reference the moment its handler ran, which may have
        // been BEFORE this component unmounted — cleanup has then already
        // come and gone and cannot release it. Setting a flag for cleanup to
        // read is not enough for that ordering (it never re-runs), so a late
        // attach releases itself. Without this the count stays pinned above
        // zero for the life of the session and main keeps forwarding
        // agent-pty-data to a renderer that is no longer listening.
        if (disposed || termRef.current !== term) {
          void window.api.detachAgentPty(sessionId)
          return true
        }
        attached = true
        const liveTerm = term
        if (!liveTerm) {
          attached = false
          void window.api.detachAgentPty(sessionId)
          return true
        }
        // Replay, with the forwarder holding its latch until xterm has parsed
        // every chunk; the backlog is strictly newer than the buffer.
        void forwarder.replay(liveTerm, [buffer, backlogQueue.join('')])
        backlogQueue.length = 0
        attachedBackfillDone = true
        if (pendingResize) {
          const measured = pendingResize
          pendingResize = null
          if (
            dimensionActiveRef.current &&
            measured.ownershipEpoch === dimensionOwnershipEpochRef.current
          ) {
            sendResizeIfChanged(measured.cols, measured.rows)
          }
        }
        if (pendingInput.length > 0) {
          void window.api.sendInput(sessionId, pendingInput.join(''))
          pendingInput.length = 0
        }
        if (focusedRef.current) liveTerm.focus()
        return true
      }

      void (async () => {
        if (await tryAttach()) {
          // Already live and showing. Still wake if the runtime says the
          // backend is gone — tryAttach only proves an entry existed.
          // Attach already succeeded; this wake is secondary. Tagged `mount`
          // because no retry follows it — the tags were swapped in review.
          if (needsWake) await ensureSessionLiveRef.current(sessionId, 'agent-terminal-leaf.mount')
          return
        }
        // Attach failed, so wake and RETRY the attach below. This is the site
        // the `attach-retry` tag describes.
        if (needsWake) await ensureSessionLiveRef.current(sessionId, 'agent-terminal-leaf.attach-retry')
        if (await tryAttach()) return
        if (disposed) return
        // Wake reported success but there is still nothing to attach to. Say
        // so instead of leaving a blank terminal that quietly eats keystrokes.
        showPaneToastRef.current(sessionId, 'Agent backend is not available to attach')
      })()
        .catch(err => {
          showPaneToastRef.current(
            sessionId,
            err instanceof Error && err.message.length > 0
              ? err.message
              : 'Could not wake agent terminal',
          )
        })

      onThemeChangedListener = (): void => {
        if (!term) return
        term.options.fontFamily = getActiveAppFontFamily()
        syncXtermTheme(term)
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
      // Only detach what we attached — see the `attached` declaration above.
      if (attached) void window.api.detachAgentPty(sessionId)
      term?.dispose()
      termRef.current = null
      onDimensionOwnershipChangeRef.current = null
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
      <div className="border-b border-border bg-surface">
        <div className="flex items-center justify-between gap-3 px-3 py-1 text-[10px] text-muted font-code select-none">
          <div className="flex items-center gap-2 min-w-0">
            {paneLabel && (
              <span className="flex-shrink-0 rounded-chip border border-current/30 px-1 leading-[14px] text-[9px] font-semibold tabular-nums">
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
        <AgentTitleHeader title={agentTitle} />
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
