import { useCallback, useEffect, useRef, useState } from 'react'

import { extractAssistantInProgress } from '@shared/parsers/extractAssistant'
import { CodexApprovalModal } from '@providers/codex/renderer/CodexApprovalModal'
import { ResumePromptModal } from '@providers/claude/renderer/ResumePromptModal'
import { useGlobalToast } from '@renderer/ui/GlobalToast'
import { Feed } from '@renderer/features/feed/ui/Feed'
import type { ScrollInfo } from '@renderer/features/feed/ui/Feed'
import { TrustDialogModal } from '@providers/claude/renderer/TrustDialogModal'
import { SlashCommandPicker } from '@providers/claude/renderer/SlashCommandPicker'
import type { SessionRuntime, Workspace } from '@renderer/workspace/workspaceStore'
import {
  selectMergedEntries,
  shouldShowSemanticStreaming,
} from '@renderer/workspace/mergedEntries'
import type { SessionId } from '@renderer/workspace/types'
import {
  CLAUDE_PASTE_THRESHOLD,
  CLAUDE_PASTE_SUBMIT_DELAY_MS,
  CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS,
  buildClaudeImagePastePayload,
  sendBracketedPasteThenSubmit,
  sendClaudeDraftText,
} from '@renderer/workspace/tile-tree/TileLeaf/claudePaste'
import { PaneHeader } from '@renderer/workspace/tile-tree/TileLeaf/PaneHeader'
import { QueueStrip } from '@renderer/workspace/tile-tree/TileLeaf/QueueStrip'
import { CompactionStrip } from '@renderer/workspace/tile-tree/TileLeaf/CompactionStrip'
import { PaneToast } from '@renderer/workspace/tile-tree/TileLeaf/PaneToast'
import { ScrollIndicator } from '@renderer/workspace/tile-tree/TileLeaf/ScrollIndicator'
import { useComposerAutoGrow } from '@renderer/workspace/tile-tree/TileLeaf/useComposerAutoGrow'
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
  // True while we're forwarding keystrokes to the PTY for a slash
  // command. Controls key routing in onKeyDown and render of the
  // picker dropdown (we still render the dropdown from runtime.picker,
  // but we use slashMode to decide whether keys should be forwarded
  // vs. stored locally).
  const [slashMode, setSlashMode] = useState(false)

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

  const exitSlashMode = () => {
    setSlashMode(false)
    setInputText('')
  }

  const onKeyDown = async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Global keybinds bubble up to the document-level listener in
    // useKeybinds; if a modifier-combo handler called preventDefault
    // already, skip processing here to avoid routing pane-management
    // keys into the PTY as text.
    if (e.defaultPrevented) return

    // ---- Slash mode entry ----
    //
    // Only when input is empty AND the user types `/`. That way normal
    // text containing a `/` in the middle (a URL, a path) doesn't
    // accidentally flip us into slash mode.
    if (!slashMode && input === '' && e.key === '/') {
      e.preventDefault()
      await send('/')
      setInputText('/')
      setSlashMode(true)
      return
    }

    // ---- Slash mode: forward every key to PTY ----
    if (slashMode) {
      e.preventDefault()

      if (e.key === 'Escape') {
        // Send ESC to CC (dismisses the picker) and exit slash mode.
        // slashMode is intentionally flipped off BEFORE the picker's
        // next screen update arrives — we don't want to wait for CC
        // to confirm the dismissal before letting the user type.
        await send('\x1b')
        exitSlashMode()
        return
      }
      if (e.key === 'Enter') {
        // Commit whatever CC has highlighted. If there's no highlight
        // CC will just send the literal text as a regular prompt.
        await send('\r')
        exitSlashMode()
        return
      }
      if (e.key === 'Backspace') {
        await send('\x7f')
        const next = input.slice(0, -1)
        setInputText(next)
        // If the user backspaces all the way out, we're no longer in
        // slash mode — fall back to the normal composer.
        if (next === '') setSlashMode(false)
        return
      }
      if (e.key === 'ArrowUp') {
        await send('\x1b[A')
        return
      }
      if (e.key === 'ArrowDown') {
        await send('\x1b[B')
        return
      }
      if (e.key === 'ArrowLeft') {
        await send('\x1b[D')
        return
      }
      if (e.key === 'ArrowRight') {
        await send('\x1b[C')
        return
      }
      if (e.key === 'Tab') {
        await send('\t')
        return
      }
      // Single printable char: forward + mirror into local state so
      // the React input visibly tracks what CC has in its buffer.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        await send(e.key)
        setInputText(input + e.key)
        return
      }
      // Ignore shift, ctrl, meta, function keys, etc. while in slash mode.
      return
    }

    // ---- Normal mode ----
    //
    // Shift+Enter: insert a literal newline in the composer (normal
    // textarea behavior). We DON'T preventDefault so the browser handles
    // the insertion, and we don't forward anything to the PTY — the
    // newline only becomes visible to CC when the user commits with a
    // bare Enter below. This gives multi-line prompt editing without
    // touching the PTY until the user actually wants to send.
    if (e.key === 'Enter' && e.shiftKey) {
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const draftImages = runtime.draftImages
      if (input.trim().length === 0 && draftImages.length === 0) {
        return
      }
      // Capture streaming baseline from the very freshest screen text
      // so the streaming card can detect "this is the old response"
      // reliably. latestScreenRef is mutated synchronously on every
      // IPC screen event so this is always current.
      const screen = workspace.latestScreenRef.current[sessionId] ?? ''
      const provider = workspace.state.sessions[sessionId]?.kind === 'codex' ? 'codex' : 'claude'
      const baseline = extractAssistantInProgress(screen, provider)
      workspace.setStreamingBaseline(sessionId, baseline)
      if (provider === 'codex') {
        // Codex does not reliably give us a structured user message at submit
        // time the way Claude does. Seed the feed immediately from the local
        // composer state so "submit" is visible even if rollout JSON is late.
        workspace.addOptimisticCodexUserEntry(sessionId, input)
      }

      try {
        const hasClaudeImages = provider === 'claude' && draftImages.length > 0
        // Three submit modes live here because the two providers'
        // input stacks are similar but NOT equivalent:
        //
        //   1. Codex: always bracketed-paste, always trailing Enter
        //      outside the paste block, both in one write. This is the
        //      path that fixed Codex swallowing `\r` as pasted text.
        //
        //   2. Claude, normal text: raw text + `\r` in one write. Fast
        //      path for the overwhelmingly common case.
        //
        //   3. Claude, paste-like text (multiline OR long enough to hit
        //      Claude's own paste path): bracketed paste first, THEN a
        //      delayed `\r` in a second write. This is the critical fix
        //      for the "first Enter populates the prompt but does not
        //      actually submit; second Enter finally sends it" bug.
        const isClaudePasteLike =
          provider === 'claude' &&
          (input.includes('\n') || input.length > CLAUDE_PASTE_THRESHOLD)

        if (provider === 'codex') {
          await sendBracketedPasteThenSubmit(send, input)
        } else if (hasClaudeImages) {
          const savedImages = await Promise.all(
            draftImages.map(image =>
              window.api.saveClaudeImage({
                base64Data: image.base64Data,
                mediaType: image.mediaType,
                filename: image.filename,
              }),
            ),
          )
          const imagePaths = savedImages.map(image => image.path)
          if (input.length > 0) {
            await sendClaudeDraftText(send, input)
            // Claude collapses the following path paste into image pills.
            // If the user's prompt ends in a non-whitespace character,
            // inject one separator so the final prompt text does not run
            // directly into the first `[Image #N]` placeholder.
            if (!/\s$/.test(input)) {
              await send(' ')
            }
          }
          const payload = buildClaudeImagePastePayload('', imagePaths)
          await sendBracketedPasteThenSubmit(send, payload, CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS)
        } else if (isClaudePasteLike) {
          // Keep the submit key OUT of the bracketed-paste write and
          // wait past Claude's paste debounce. Sending `\r` in the same
          // PTY chunk races Claude's paste accumulator and can leave the
          // prompt sitting in the composer until a later keypress nudges
          // it through the normal submit path.
          await sendBracketedPasteThenSubmit(send, input, CLAUDE_PASTE_SUBMIT_DELAY_MS)
        } else {
          await send(input + '\r')
        }
        setInputText('')
        if (provider === 'claude' && draftImages.length > 0) {
          setDraftImages(sessionId, [])
        }
      } catch (err) {
        // Keep the draft visible if main no longer has a live session for this
        // pane. Clearing the composer on a dropped write makes the failure look
        // like Codex ignored the prompt when it never received it.
        if (provider === 'codex') {
          workspace.removeOptimisticCodexUserEntry(sessionId, input)
        }
        console.warn('[TileLeaf] submit failed', err)
      }
      // Any submit exits history cycling — the prompt is committed
      // and the next Up should start a fresh walk from the (now
      // updated) newest entry, not continue from wherever we were.
      endHistoryCycle()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      await send('\x1b')
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      await send('\x03')
      setInputText('')
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      await send('\x04')
      return
    }
    // ---- Prompt history: Up cycles BACKWARD into past prompts ----
    //
    // Entry gate: we ONLY enter cycling when the composer is
    // currently empty. That's deliberately more restrictive than
    // bash's "cycle even with a partial draft and restore on Down".
    // The permissive version caused real confusion — users pressing
    // Up with a mid-typed prompt would watch their draft get
    // replaced with a random historic prompt and think something
    // was injecting text into their input. The anchor-restore
    // mechanism was there but non-obvious. Requiring an empty
    // composer makes the feature discoverable and non-destructive:
    // you have to actively clear your input before you can cycle.
    //
    // Once cycling has STARTED (historyIndex !== null), subsequent
    // Up/Down steps don't re-check emptiness — the composer is
    // showing a historic prompt, not user typing, so stepping
    // further is obviously safe.
    //
    // Modifier combos (Shift/Ctrl/Meta/Alt+Up) fall through to the
    // PTY-forward path so OS line-navigation shortcuts still reach
    // CC when the user wants them.
    // Skip history cycling when the approval overlay is visible —
    // arrow keys need to reach the PTY so Codex can navigate its
    // selection list.
    if (
      e.key === 'ArrowUp' &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !runtime.pendingApproval &&
      !runtime.pendingTrustDialog &&
      !runtime.pendingResumePrompt &&
      history.length > 0 &&
      (cyclingHistory || input === '')
    ) {
      e.preventDefault()
      if (!cyclingHistory) {
        // First entry into cycling: the composer is empty (per the
        // gate above), so the anchor is also empty. Storing it
        // anyway keeps the Down-past-newest restore path uniform.
        setHistoryAnchor('')
        setHistoryIndex(0)
        setInputText(history[0])
      } else {
        const next = Math.min(historyIndex! + 1, history.length - 1)
        if (next !== historyIndex) {
          setHistoryIndex(next)
          setInputText(history[next])
        }
      }
      return
    }

    // ---- Prompt history: Down cycles FORWARD toward the anchor ----
    //
    // Only meaningful while we're already cycling. Pressing Down
    // outside a cycle shouldn't do anything (no forward history to
    // cycle to). We also don't need the cursorOnBottomRow check the
    // old version had, because the composer's content during
    // cycling is a historic prompt the user hasn't touched — there's
    // no multi-line-draft caret navigation to preserve.
    if (
      e.key === 'ArrowDown' &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !runtime.pendingApproval &&
      !runtime.pendingTrustDialog &&
      !runtime.pendingResumePrompt &&
      cyclingHistory
    ) {
      e.preventDefault()
      const next = historyIndex! - 1
      if (next < 0) {
        // Past the newest historic prompt — restore the anchor
        // (empty, since the Up gate only lets us in from an empty
        // composer) and exit cycle mode so the next Up starts fresh.
        setHistoryIndex(null)
        setInputText(historyAnchor)
      } else {
        setHistoryIndex(next)
        setInputText(history[next])
      }
      return
    }

    // Fallback: any other Up/Down (not cycling, not at top/bottom
    // row, or with a modifier) falls through to the old PTY-forward
    // path so CC's own history / caret navigation still reaches it
    // when appropriate.
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      await send('\x1b[A')
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      await send('\x1b[B')
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      await send('\t')
      return
    }
  }

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

      {/* Composer */}
      <div className="flex-shrink-0 border-t border-border bg-surface px-3 py-2 relative">
        {/* SlashCommandPicker is absolutely positioned relative to this
            composer container so it floats above the input without
            shifting layout. */}
        <SlashCommandPicker state={runtime.picker} />

        {/* The composer is a <textarea> (not <input>) so the box can
            grow vertically to fit a multi-line prompt. See the
            useEffect above that drives the height off scrollHeight.
            The chevron is aligned to the top of the box instead of
            vertically-centered because a 10-line prompt looks odd
            with a chevron floating in the middle of nowhere. */}
        {provider === 'claude' && runtime.draftImages.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {runtime.draftImages.map(image => (
              <div
                key={image.id}
                className="relative w-24 rounded border border-border bg-canvas p-1"
              >
                <button
                  type="button"
                  className="absolute right-1 top-1 z-10 h-5 w-5 rounded-full bg-surface/90 text-[12px] leading-none text-ink hover:bg-surface"
                  onClick={() => removeDraftImage(image.id)}
                  aria-label={`Remove ${image.filename}`}
                >
                  ×
                </button>
                <img
                  src={image.previewUrl}
                  alt={image.filename}
                  className="h-16 w-full rounded object-cover"
                />
                <div className="mt-1 truncate text-[10px] font-code text-muted">
                  {image.filename}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="relative">
          <div className="absolute left-2 top-[10px] text-accent text-[12px] pointer-events-none select-none">
            ❯
          </div>
          <textarea
            ref={inputRef}
            rows={1}
            className={`
              w-full bg-canvas border
              ${focused ? 'border-accent' : 'border-border'}
              text-ink text-[12px]
              pl-6 pr-2 py-2 outline-none
              placeholder:text-muted
              transition-colors duration-150
              resize-none overflow-hidden leading-[1.4]
              font-code
            `}
            value={input}
            onChange={e => {
              // In slash mode we manage the value ourselves via
              // onKeyDown; the browser's default onChange (which fires
              // on paste, IME composition end, etc.) would duplicate
              // keystrokes that we already forwarded. Ignore in slash
              // mode — the display value is already in sync because
              // onKeyDown called setInputText.
              if (slashMode) return
              setInputText(e.target.value)
              // ANY user edit (typing, paste, delete) cancels history
              // cycling: once they've touched the recalled prompt it's
              // theirs, and the next Up should start fresh from the
              // newest entry rather than continuing the old cycle.
              // The Up/Down handlers set historyIndex AND call
              // setInputText, which would trigger this onChange and
              // wipe their own state — so we guard against that by
              // only ending the cycle when the NEW value differs from
              // whatever history slot we're currently parked on.
              if (
                historyIndex !== null &&
                e.target.value !== history[historyIndex]
              ) {
                endHistoryCycle()
              }
            }}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            onFocus={onFocusRequest}
            placeholder={
              slashMode
                ? undefined
                : focused
                  ? 'type and press enter… (shift+enter for newline)'
                  : ''
            }
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>

      {/* Per-pane trust dialog: only shown if THIS pane's screen buffer
          contains the trust prompt. Other panes have their own modals. */}
      <TrustDialogModal state={runtime.pendingTrustDialog} onSend={send} />
    </div>
  )
}

// shortenCwd + providerLabel moved to ./TileLeaf/labels.ts.
