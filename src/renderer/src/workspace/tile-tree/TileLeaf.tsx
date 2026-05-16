import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import { Feed } from '@renderer/features/feed/ui/Feed'
import type { ScrollInfo } from '@renderer/features/feed/ui/Feed'
import { ProviderConditionOutlet } from '@providers/shared/renderer/conditions/ProviderConditionOutlet'
import type { SessionRuntime, Workspace } from '@renderer/workspace/workspaceStore'
import {
  selectMergedEntries,
  shouldShowSemanticStreaming,
} from '@renderer/workspace/mergedEntries'
import type { SessionId } from '@renderer/workspace/types'
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'
import { QueueStrip } from '@renderer/workspace/tile-tree/TileLeaf/QueueStrip'
import { PaneToast } from '@renderer/workspace/tile-tree/TileLeaf/PaneToast'
import { ScrollIndicator } from '@renderer/workspace/tile-tree/TileLeaf/ScrollIndicator'
import { ComposerInput } from '@renderer/workspace/tile-tree/TileLeaf/ComposerInput'
import { useComposerAutoGrow } from '@renderer/workspace/tile-tree/TileLeaf/useComposerAutoGrow'
import { useComposerKeybinds } from '@renderer/workspace/tile-tree/TileLeaf/useComposerKeybinds'
import { useComposerDictation } from '@renderer/workspace/tile-tree/TileLeaf/useComposerDictation'
import { useTypeToFocus } from '@renderer/workspace/tile-tree/TileLeaf/useTypeToFocus'
import { usePasteToFocus } from '@renderer/workspace/tile-tree/TileLeaf/usePasteToFocus'
import { usePromptHistory } from '@renderer/workspace/tile-tree/TileLeaf/usePromptHistory'
import { useClaudeImagePaste } from '@renderer/workspace/tile-tree/TileLeaf/useClaudeImagePaste'
import { recordHtmlTraceSnapshot } from '@renderer/features/debug/renderTrace'

// Claude paste-state-machine constants + helpers moved to
// ./TileLeaf/claudePaste.ts. Image helpers moved to
// ./TileLeaf/claudeImages.ts. Label helpers moved to
// ./TileLeaf/labels.ts. See those files for the full rationale on
// the paste debounce, the image size/format gates, and the pane
// header shortening.

// TileLeaf — one pane. A "mini Agent Code" self-contained in a box:
//   header strip (project dir + status)
//   Feed (structured JSONL + streaming preview)
//   composer (input box routing keystrokes to this pane's session)
//   SlashCommandPicker overlay (when slashMode is active)
//   trust dialog overlay (scoped to this pane, not window-global)
//
// All per-session runtime state comes in through the `runtime` prop —
// this component never touches window.api except for sendInput.
// That's the boundary: the store owns event subscriptions + mutations,
// TileLeaf owns rendering and keyboard input for its specific session.
//
// Slash-mode behavior:
//   When the input is empty and the user types `/`, we flip into
//   "slash mode". In slash mode EVERY keystroke is forwarded directly
//   to the PTY (including the `/` itself), and we keep the React input
//   value in sync with what we've sent so the user still sees their
//   filter text. The slash command picker renders as a dropdown above
//   the composer, driven entirely by picker state the main-process
//   parser detected from CC's screen buffer. Arrow keys navigate the
//   picker (forwarded), Enter commits, Escape cancels. See
//   src/core/parsers/slashCommandPicker.ts for the parser.
//
// We deliberately DON'T track "is the picker visible?" to decide when
// to enter/exit slash mode. That would race the IPC snapshot interval:
// the user types `/` and expects the next keystroke to go to CC, but
// picker.visible might still be false in state for another 16ms. So
// slashMode is local state that flips on `/` and flips off on
// Enter/Escape/backspace-to-empty. The picker is a purely visual
// reflection of CC's state; it doesn't gate anything.

type Props = {
  sessionId: SessionId
  runtime: SessionRuntime
  paneLabel?: string
  focused: boolean
  onFocusRequest: () => void
  workspace: Workspace
  showStatusMode?: boolean
  showWorktreeBadges?: boolean
}

export function TileLeaf({
  sessionId,
  runtime,
  paneLabel,
  focused,
  onFocusRequest,
  workspace,
  showStatusMode = true,
  showWorktreeBadges = true,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const { showToast } = useGlobalToast()
  const feedDebugPanelOpen = useAppStore(state => state.feedDebugPanelOpen)
  const htmlDebugPanelOpen = useAppStore(state => state.htmlDebugPanelOpen)
  const dictationEnabled = useAppStore(state => state.settings.dictationEnabled)
  const dictationProvider = useAppStore(state => state.settings.dictationProvider)
  const dictationShortcut = useAppStore(state => state.settings.dictationShortcut)
  // Destructure the stable useCallback setter so effect deps don't
  // spuriously invalidate on every parent render. workspace itself
  // is a fresh object literal each render, but its methods are
  // memoed via useCallback in workspaceStore — depping on the
  // method gives us "re-run only when the workspace rebuilds the
  // callback", which in practice is never.
  const { acknowledgeSession: acknowledgeWorkspaceSession, setDraftInput } = workspace
  // Draft input lives in the workspace runtime (not local useState)
  // so it survives TileLeaf unmount when the user switches tabs.
  // App.tsx only mounts the active tab's tree — inactive tabs are
  // unmounted, not hidden — so any component-local state dies on
  // tab switch. See SessionRuntime.draftInput for the full reasoning.
  //
  // We keep a local `setInputText` adapter so the rest of this file
  // reads the same way it did before the hoist. The source of truth
  // is runtime.draftInput; this adapter writes THROUGH to the store.
  const input = runtime.draftInput
  const setInputText = (next: string) => {
    setDraftInput(sessionId, next)
  }
  const acknowledgeSession = useCallback(() => {
    acknowledgeWorkspaceSession(sessionId)
  }, [acknowledgeWorkspaceSession, sessionId])
  const setDraftImages = workspace.setDraftImages
  const provider: 'claude' | 'codex' =
    workspace.state.sessions[sessionId]?.kind === 'codex' ? 'codex' : 'claude'

  // Auto-grow the composer textarea to fit its content — hook lives
  // in ./TileLeaf/useComposerAutoGrow.ts, see there for the
  // "why manual measurement instead of field-sizing:content" story.
  useComposerAutoGrow(inputRef, input)
  // Scroll position for the indicator above the composer. Updated on
  // every scroll tick via onScrollInfo callback from Feed. fraction=0
  // means at bottom, fraction=1 means at top.
  const [scrollFraction, setScrollFraction] = useState(0)
  const scrollFractionRef = useRef(0)
  const onScrollInfo = useCallback((info: ScrollInfo) => {
    if (Math.abs(info.fraction - scrollFractionRef.current) < 0.005) return
    scrollFractionRef.current = info.fraction
    setScrollFraction(info.fraction)
  }, [])

  // Prompt history — state + derivation live in
  // ./TileLeaf/usePromptHistory.ts. Returns the history list, the
  // cycle cursor/anchor, and endHistoryCycle(). See that hook for
  // the transcript-filter rationale (why `permissionMode` is the
  // positive signal and what kinds of noise we had to filter out).
  const sessionKind = workspace.state.sessions[sessionId]?.kind
  const {
    history,
    historyIndex,
    historyAnchor,
    cyclingHistory,
    setHistoryIndex,
    setHistoryAnchor,
    endHistoryCycle,
  } = usePromptHistory({ entries: runtime.entries, sessionKind })

  // When focus flips to this pane, move the DOM caret into its input.
  useEffect(() => {
    if (focused) inputRef.current?.focus()
  }, [focused])

  // Type-to-focus — document-level key listener that routes printable
  // keys into the composer when the pane is focused but DOM focus
  // drifted elsewhere. Hook in ./TileLeaf/useTypeToFocus.ts owns
  // the full filter/injection logic.
  useTypeToFocus({
    focused,
    sessionId,
    inputRef,
    setDraftInput,
    onUserEngagement: acknowledgeSession,
  })

  // Optional `pasteId` correlates this write into the per-paste debug
  // journal in main. Set only by the paste-submit flow in
  // useComposerKeybinds; all other callers (history navigation, slash
  // forwarding, dictation injection) leave it undefined and pay no
  // journaling cost. The pasteId-aware path is the diagnostic for the
  // "first Enter sometimes does nothing" intermittent — see
  // `docs/superpowers/plans/2026-05-11-paste-submit-harness-findings-and-fix.md`.
  const send = async (data: string, pasteId?: string) => {
    acknowledgeSession()
    if (
      !runtime.inputReady ||
      runtime.processStatus !== 'started' ||
      runtime.exited !== null
    ) {
      workspace.showPaneToast(
        sessionId,
        runtime.processStatus === 'failed'
          ? (runtime.processError ?? 'Agent failed to start')
          : runtime.processStatus === 'exited'
            ? 'Agent has exited'
            : 'Agent is still starting; draft preserved',
      )
      return
    }
    const ok = await window.api.sendInput(sessionId, data, pasteId)
    if (!ok) {
      throw new Error(`sendInput failed for missing session ${sessionId}`)
    }
  }

  const loadOlderHistory = useCallback(async () => {
    await workspace.loadOlderHistory(sessionId)
  }, [sessionId, workspace.loadOlderHistory])

  const appendRenderDebug = useCallback((entry: Parameters<typeof workspace.appendFeedDebug>[1]) => {
    workspace.appendFeedDebug(sessionId, entry)
  }, [sessionId, workspace.appendFeedDebug])

  // Claude image-paste flow — three clipboard ingress paths, media-
  // type gate, 5 MB size cap. Hook in ./TileLeaf/useClaudeImagePaste.ts.
  const { handlePaste, removeDraftImage } = useClaudeImagePaste({
    provider,
    sessionId,
    setDraftImages,
    showToast,
  })

  // Paste-to-focus — document-level paste listener that routes the
  // clipboard into the composer when the pane is focused but DOM
  // focus drifted off the textarea. The paste sibling of
  // useTypeToFocus above; it shares `handlePaste` so pasted images
  // go through the exact same gates as a textarea paste. Hook in
  // ./TileLeaf/usePasteToFocus.ts. Declared here (not next to
  // useTypeToFocus) because it depends on `handlePaste`.
  usePasteToFocus({
    focused,
    sessionId,
    inputRef,
    setDraftInput,
    onUserEngagement: acknowledgeSession,
    handlePaste,
  })

  // Composer keybinds — slash-mode + normal-mode + prompt-history
  // cycling. Hook in ./TileLeaf/useComposerKeybinds.ts; returns
  // the onKeyDown handler plus the slashMode flag that the
  // ComposerInput uses to gate its own onChange logic.
  const { onKeyDown, slashMode } = useComposerKeybinds({
    sessionId,
    provider,
    runtime,
    workspace,
    input,
    setInputText,
    send,
    history,
    historyIndex,
    historyAnchor,
    cyclingHistory,
    setHistoryIndex,
    setHistoryAnchor,
    endHistoryCycle,
  })

  const dictation = useComposerDictation({
    enabled: dictationEnabled,
    focused,
    provider: dictationProvider,
    shortcut: dictationShortcut,
    input,
    setInputText,
    onMessage: message => workspace.showPaneToast(sessionId, message),
  })

  const onComposerKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (dictation.handleShortcut(event)) return
    onKeyDown(event)
  }, [dictation, onKeyDown])

  const isSessionLive = runtime.sessionStatus === 'running'
  const readinessText =
    runtime.transcriptStatus === 'loading'
      ? 'loading transcript'
      : runtime.transcriptStatus === 'error'
        ? `transcript unavailable${runtime.transcriptError ? `: ${runtime.transcriptError}` : ''}`
        // WHY exited beats "not input ready":
        //
        // A resumed agent can die before the renderer finishes the
        // bootstrap quiet-window. That leaves `inputReady=false`,
        // which used to render "starting agent" forever even though
        // the composer correctly blocked Enter with "Agent has
        // exited". The process lifecycle is the stronger signal here:
        // once main has emitted exit, this pane is no longer starting.
        : runtime.processStatus === 'exited' || runtime.exited !== null
          ? `agent exited${runtime.exited !== null ? ` (code ${runtime.exited})` : ''}`
        : !runtime.inputReady || runtime.processStatus === 'spawning'
          ? 'starting agent'
          : runtime.processStatus === 'failed'
            ? (runtime.processError ?? 'agent failed to start')
            : null

  useEffect(() => {
    if (!htmlDebugPanelOpen || !focused) return
    const node = paneRef.current
    if (!node) return

    let timer: ReturnType<typeof window.setTimeout> | null = null
    const capture = (reason: 'initial' | 'mutation') => {
      recordHtmlTraceSnapshot(sessionId, node.outerHTML, reason)
    }
    const scheduleCapture = () => {
      if (timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        capture('mutation')
      }, 250)
    }

    capture('initial')
    const observer = new MutationObserver(scheduleCapture)
    observer.observe(node, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    })

    return () => {
      observer.disconnect()
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [focused, htmlDebugPanelOpen, sessionId])

  return (
    // data-pane-id: stable DOM hook so DOM-targeting debug tools
    // (HtmlDebugPanel in particular) can locate this pane's root via
    // document.querySelector(`[data-pane-id="${sessionId}"]`) without
    // needing a ref forwarded out of this component. The existing
    // debug panels are stateless about the DOM and read from runtime
    // props instead, so a data attribute keeps that boundary intact.
    // Session UUIDs are unique across the app, so there's no collision
    // risk with multiple panes mounted simultaneously.
    <div
      ref={paneRef}
      data-pane-id={sessionId}
      className={`
        flex flex-col h-full min-h-0 min-w-0
        border ${focused ? 'border-accent' : 'border-border'}
        bg-canvas
      `}
      onMouseDown={onFocusRequest}
    >
      <PaneHeader
        paneLabel={paneLabel}
        projectDir={runtime.projectDir}
        statusMode={showStatusMode}
        isSessionLive={isSessionLive}
      />

      {/* Feed — overflow-auto lives inside Feed itself so it can
          own its own scroll listener for the sticky-bottom logic
          (see Feed.tsx FeedImpl). This wrapper just provides the
          flex cell sizing; the scroller is a child. */}
      <div className="flex-1 min-h-0">
        <Feed
          sessionId={sessionId}
          provider={provider}
          workspaceRoot={workspace.state.sessions[sessionId]?.cwd ?? null}
          // Committed transcript + (rare) orphan-ghost fallback.
          // The layered predicate in selectMergedEntries renders
          // a ghost only when JSONL has stalled past the proxy
          // AND the ghost is not sidecar-shaped (title-gen /
          // predict-next-prompt fingerprint). The live current
          // turn is owned by `SemanticStreamingTurn` below; the
          // `currentTurnId` argument hides any ghost for that
          // turn so the two surfaces never double-render.
          // See docs/design/ghost-system.md for the canonical
          // explanation of the predicate and the dual-owner
          // model.
          entries={selectMergedEntries(
            runtime,
            runtime.semantic.currentTurn?.turnId ?? null,
          )}
          // Live text renders ONLY from the semantic channel. The
          // former `streamingScreen` / `streamingScreenMarkdown` /
          // `streamingBaseline` props are gone — Feed no longer
          // parses the TUI buffer at render time. Screen-derived
          // live text now arrives via the semantic channel tagged
          // `source: 'screen'`, published by the headless packages
          // with a baseline gate that prevents the previous turn's
          // text from leaking into the new turn's first delta.
          activityStatus={runtime.activityStatus}
          // Adapter-derived stream phase — drives the in-feed
          // WorkIndicator. The renderer never re-derives; it just
          // displays whatever phase the headless package published.
          // See 2026-04-18-thinking-phase-in-headless.md for the
          // derivation contract.
          streamPhase={runtime.streamPhase}
          streamPhasePendingToolName={runtime.streamPhasePendingToolName}
          streamPhasePendingToolUseId={runtime.streamPhasePendingToolUseId}
          turnStartedAt={runtime.turnStartedAt}
          // Live-turn ownership: SemanticStreamingTurn renders the
          // current turn end-to-end off the semantic channel.
          // Ghosts for the same turnId are filtered out of the
          // merged feed by selectMergedEntries (currentTurnId
          // argument), so there is no double-render risk.
          // shouldShowSemanticStreaming collapses to "is there a
          // current turn?".
          semanticTurn={
            shouldShowSemanticStreaming(runtime)
              ? runtime.semantic.currentTurn
              : null
          }
          tailMode={runtime.tailMode}
          pickerSelectedUuid={runtime.assistantPicker?.selectedUuid ?? null}
          onScrollInfo={onScrollInfo}
          onUserEngagement={acknowledgeSession}
          hasOlderHistory={runtime.hasOlderHistory}
          loadingOlderHistory={runtime.loadingOlderHistory}
          onLoadOlderHistory={loadOlderHistory}
          // Bootstrap-replay perf wiring — see workspaceStore +
          // Feed for the WHY. While `bootstrapping` is true Feed
          // suspends per-append auto-scroll and lazy-mount cascades;
          // the indices spare Feed from a useMemo rebuild on every
          // append.
          bootstrapping={runtime.bootstrapping}
          scrollToLatestRequest={runtime.scrollToLatestRequest}
          toolUseIndex={runtime.toolUseIndex}
          toolResultIndex={runtime.toolResultIndex}
          onDebugLog={feedDebugPanelOpen && focused ? appendRenderDebug : undefined}
        />
      </div>

      <QueueStrip queuedMessages={runtime.queuedMessages} />

      {readinessText && (
        <div className="flex-shrink-0 border-t border-border bg-surface px-3 py-1 font-code text-[10px] text-muted">
          {readinessText}
        </div>
      )}

      <ProviderConditionOutlet
        conditions={runtime.conditions}
        onSend={send}
      />

      <PaneToast message={runtime.paneToast} />

      <ScrollIndicator
        entryCount={runtime.entries.length}
        totalEntries={runtime.totalEntries}
        scrollFraction={scrollFraction}
        tailMode={runtime.tailMode}
        sessionKind={workspace.state.sessions[sessionId]?.kind}
        workContext={showWorktreeBadges ? runtime.workContext : null}
        workActivity={showWorktreeBadges ? runtime.workActivity : null}
      />

      <ComposerInput
        inputRef={inputRef}
        input={input}
        focused={focused}
        slashMode={slashMode}
        provider={provider}
        draftImages={runtime.draftImages}
        pickerState={runtime.picker}
        historyIndex={historyIndex}
        history={history}
        setInputText={setInputText}
        endHistoryCycle={endHistoryCycle}
        onKeyDown={onComposerKeyDown}
        onPaste={handlePaste}
        onFocusRequest={onFocusRequest}
        onUserEngagement={acknowledgeSession}
        removeDraftImage={removeDraftImage}
        dictation={dictation}
      />
    </div>
  )
}

// shortenCwd + providerLabel moved to ./TileLeaf/labels.ts.
