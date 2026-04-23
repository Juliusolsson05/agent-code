import { useCallback, useEffect, useRef, useState } from 'react'

import { CodexApprovalModal } from '@providers/codex/renderer/CodexApprovalModal'
import { ResumePromptModal } from '@providers/claude/renderer/ResumePromptModal'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import { Feed } from '@renderer/features/feed/ui/Feed'
import type { ScrollInfo } from '@renderer/features/feed/ui/Feed'
import { TrustDialogModal } from '@providers/claude/renderer/TrustDialogModal'
import type { SessionRuntime, Workspace } from '@renderer/workspace/workspaceStore'
import {
  selectMergedEntries,
  shouldShowSemanticStreaming,
} from '@renderer/workspace/mergedEntries'
import type { SessionId } from '@renderer/workspace/types'
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'
import { QueueStrip } from '@renderer/workspace/tile-tree/TileLeaf/QueueStrip'
import { CompactionStrip } from '@renderer/workspace/tile-tree/TileLeaf/CompactionStrip'
import { PaneToast } from '@renderer/workspace/tile-tree/TileLeaf/PaneToast'
import { ScrollIndicator } from '@renderer/workspace/tile-tree/TileLeaf/ScrollIndicator'
import { ComposerInput } from '@renderer/workspace/tile-tree/TileLeaf/ComposerInput'
import { useComposerAutoGrow } from '@renderer/workspace/tile-tree/TileLeaf/useComposerAutoGrow'
import { useComposerKeybinds } from '@renderer/workspace/tile-tree/TileLeaf/useComposerKeybinds'
import { useTypeToFocus } from '@renderer/workspace/tile-tree/TileLeaf/useTypeToFocus'
import { usePromptHistory } from '@renderer/workspace/tile-tree/TileLeaf/usePromptHistory'
import { useClaudeImagePaste } from '@renderer/workspace/tile-tree/TileLeaf/useClaudeImagePaste'

// Claude paste-state-machine constants + helpers moved to
// ./TileLeaf/claudePaste.ts. Image helpers moved to
// ./TileLeaf/claudeImages.ts. Label helpers moved to
// ./TileLeaf/labels.ts. See those files for the full rationale on
// the paste debounce, the image size/format gates, and the pane
// header shortening.

// TileLeaf — one pane. A "mini cc-shell" self-contained in a box:
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
  focused: boolean
  onFocusRequest: () => void
  workspace: Workspace
}

export function TileLeaf({
  sessionId,
  runtime,
  focused,
  onFocusRequest,
  workspace,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { showToast } = useGlobalToast()
  // Destructure the stable useCallback setter so effect deps don't
  // spuriously invalidate on every parent render. workspace itself
  // is a fresh object literal each render, but its methods are
  // memoed via useCallback in workspaceStore — depping on the
  // method gives us "re-run only when the workspace rebuilds the
  // callback", which in practice is never.
  const { setDraftInput } = workspace
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
  const onScrollInfo = useCallback((info: ScrollInfo) => {
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
  useTypeToFocus({ focused, sessionId, inputRef, setDraftInput })

  const send = async (data: string) => {
    const ok = await window.api.sendInput(sessionId, data)
    if (!ok) {
      throw new Error(`sendInput failed for missing session ${sessionId}`)
    }
  }

  // Claude image-paste flow — three clipboard ingress paths, media-
  // type gate, 5 MB size cap. Hook in ./TileLeaf/useClaudeImagePaste.ts.
  const { handlePaste, removeDraftImage } = useClaudeImagePaste({
    provider,
    sessionId,
    setDraftImages,
    showToast,
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

  const running = runtime.exited === null
  const isSessionLive = runtime.sessionStatus === 'running'

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
      data-pane-id={sessionId}
      className={`
        flex flex-col h-full min-h-0 min-w-0
        border ${focused ? 'border-accent' : 'border-border'}
        bg-canvas
      `}
      onMouseDown={onFocusRequest}
    >
      <PaneHeader
        projectDir={runtime.projectDir}
        statusMode={workspace.statusMode}
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
          // Merged upstream + ghost feed. Split ownership: the live
          // turn's ghosts are EXCLUDED from the merge (the live view
          // component below is the sole owner of the current turn);
          // earlier turns' orphaned or still-unreconciled ghosts fall
          // through. The `currentTurnId` argument is what encodes that
          // split — see `./mergedEntries.ts` for the filter and
          // docs/superpowers/plans/2026-04-20-rendering-fixes.md
          // Task 5 for the WHY.
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
          // current turn end-to-end. Earlier un-reconciled ghosts
          // are now filtered OUT of the merged feed (see the
          // `currentTurnId` argument to selectMergedEntries above),
          // so there is no double-render risk — the two surfaces
          // own different time slices. `shouldShowSemanticStreaming`
          // collapses to "is there a current turn?" as a result.
          // See
          // docs/superpowers/plans/2026-04-20-rendering-fixes.md
          // Task 5 and
          // docs/superpowers/plans/2026-04-17-claude-semantic-provider-gating.md.
          semanticTurn={
            shouldShowSemanticStreaming(runtime)
              ? runtime.semantic.currentTurn
              : null
          }
          tailMode={runtime.tailMode}
          pickerSelectedUuid={runtime.assistantPicker?.selectedUuid ?? null}
          onScrollInfo={onScrollInfo}
          hasOlderHistory={runtime.hasOlderHistory}
          loadingOlderHistory={runtime.loadingOlderHistory}
          onLoadOlderHistory={async () => {
            await workspace.loadOlderHistory(sessionId)
          }}
          // Bootstrap-replay perf wiring — see workspaceStore +
          // Feed for the WHY. While `bootstrapping` is true Feed
          // suspends per-append auto-scroll and lazy-mount cascades;
          // the indices spare Feed from a useMemo rebuild on every
          // append.
          bootstrapping={runtime.bootstrapping}
          scrollToLatestRequest={runtime.scrollToLatestRequest}
          toolUseIndex={runtime.toolUseIndex}
          toolResultIndex={runtime.toolResultIndex}
          onDebugLog={entry => workspace.appendFeedDebug(sessionId, entry)}
        />
      </div>

      <QueueStrip queuedMessages={runtime.queuedMessages} />

      {/* Codex approval prompt — rendered inline in the pane, matching
          how Codex's TUI draws it. Sits between feed and composer. */}
      <CodexApprovalModal
        approval={runtime.pendingApproval}
        onSend={send}
      />

      <ResumePromptModal
        prompt={runtime.pendingResumePrompt}
        onSend={send}
      />

      <CompactionStrip pendingCompaction={runtime.pendingCompaction} />

      <PaneToast message={runtime.paneToast} />

      <ScrollIndicator
        entryCount={runtime.entries.length}
        scrollFraction={scrollFraction}
        tailMode={runtime.tailMode}
        sessionKind={workspace.state.sessions[sessionId]?.kind}
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
        onKeyDown={onKeyDown}
        onPaste={handlePaste}
        onFocusRequest={onFocusRequest}
        removeDraftImage={removeDraftImage}
      />

      {/* Per-pane trust dialog: only shown if THIS pane's screen buffer
          contains the trust prompt. Other panes have their own modals. */}
      <TrustDialogModal state={runtime.pendingTrustDialog} onSend={send} />
    </div>
  )
}

// shortenCwd + providerLabel moved to ./TileLeaf/labels.ts.
