import { useState } from 'react'

import { extractAssistantInProgress } from '@shared/parsers/extractAssistant'

import type { SessionId } from '@renderer/workspace/types'
import type { SessionRuntime, Workspace } from '@renderer/workspace/workspaceStore'
import { isSessionExited } from '@renderer/workspace/providerSessionIdentity'
import {
  CLAUDE_PASTE_THRESHOLD,
  CLAUDE_PASTE_SUBMIT_DELAY_MS,
  CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS,
  buildClaudeImagePastePayload,
  sendBracketedPasteThenSubmit,
  sendClaudeDraftText,
} from '@renderer/workspace/tile-tree/TileLeaf/claudePaste'
import { hasActionCondition } from '@renderer/workspace/conditions/selectors'

// The big onKeyDown handler for the composer textarea.
//
// Three interleaved concerns:
//   1. Slash-mode routing — once the composer enters slash mode,
//      every keystroke forwards to the PTY (Claude's own picker
//      consumes them) and we mirror the text into React state so
//      the visible input stays in sync with CC's buffer.
//   2. Normal mode — Enter submits the draft, Ctrl+C cancels,
//      Escape forwards, Shift+Enter inserts a literal newline.
//      The submit path forks by provider because Claude and
//      Codex have DIFFERENT paste + submit timing requirements
//      (see claudePaste.ts for the debounce story).
//   3. Bash-style prompt history — Up/Down cycle through previous
//      prompts when the composer is empty. Modifier combos fall
//      through to the PTY-forward path so OS line navigation
//      still works when the user wants it.
//
// We return the handler + slash-mode state because the
// composer's controlled textarea needs to read `slashMode` in its
// onChange handler too (to suppress React's own value propagation
// when onKeyDown has already forwarded the keystroke).

export type UseComposerKeybindsArgs = {
  sessionId: SessionId
  provider: 'claude' | 'codex'
  runtime: SessionRuntime
  workspace: Workspace
  input: string
  setInputText: (next: string) => void
  send: (data: string, pasteId?: string) => Promise<void>
  history: string[]
  historyIndex: number | null
  historyAnchor: string
  cyclingHistory: boolean
  setHistoryIndex: (index: number | null) => void
  setHistoryAnchor: (text: string) => void
  endHistoryCycle: () => void
}

export function useComposerKeybinds({
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
}: UseComposerKeybindsArgs) {
  // True while we're forwarding keystrokes to the PTY for a slash
  // command. Controls key routing in onKeyDown and render of the
  // picker dropdown (we still render the dropdown from
  // runtime.picker, but we use slashMode to decide whether keys
  // should be forwarded vs. stored locally).
  const [slashMode, setSlashMode] = useState(false)
  const exitSlashMode = () => {
    setSlashMode(false)
    setInputText('')
  }

  const backendReady =
    runtime.inputReady &&
    runtime.processStatus === 'started' &&
    !isSessionExited(runtime)
  const hasBlockingCondition = hasActionCondition(runtime.conditions)
  const blockBackendWrite = () => {
    workspace.showPaneToast(
      sessionId,
      runtime.processStatus === 'failed'
        ? (runtime.processError ?? 'Agent failed to start')
        : isSessionExited(runtime)
          ? 'Agent has exited'
          : 'Agent is still starting; draft preserved',
      )
  }

  const submitCurrentDraft = async (
    source: 'textarea-enter' | 'global-enter',
    hasModifier = false,
  ) => {
    const draftImages = runtime.draftImages
    if (input.trim().length === 0 && draftImages.length === 0) return
    if (!backendReady) {
      blockBackendWrite()
      return
    }
    // Mint a paste-debug id at the EARLIEST observable moment of
    // the Enter press — before provider routing, before state
    // mutation, before any async work. If the bug is "the Enter
    // handler fires twice and the second \r races", both invocations
    // will mint distinct pasteIds and the debug dump will show two
    // separate journal files for what the user perceived as one press.
    // See docs/superpowers/plans/2026-05-11-paste-submit-...md for
    // the hypothesis space.
    const pasteId = crypto.randomUUID()
    window.api.recordPasteDebugEvent(pasteId, {
      layer: 'RENDER',
      event: 'keydown:enter',
      data: {
        source,
        composerLen: input.length,
        composerHead: input.slice(0, 240),
        isPasteLike: input.includes('\n') || input.length > CLAUDE_PASTE_THRESHOLD,
        hasDraftImages: draftImages.length > 0,
        hasModifier,
        backendReady,
        sessionId,
      },
    })
    // Capture streaming baseline from the very freshest screen
    // text so the streaming card can detect "this is the old
    // response" reliably. latestScreenRef is mutated
    // synchronously on every IPC screen event so this is always
    // current.
    const screen = workspace.latestScreenRef.current[sessionId] ?? ''
    const submitProvider: 'claude' | 'codex' =
      workspace.state.sessions[sessionId]?.kind === 'codex' ? 'codex' : 'claude'
    const baseline = extractAssistantInProgress(screen, submitProvider)
    workspace.setStreamingBaseline(sessionId, baseline)
    if (submitProvider === 'codex') {
      // Codex does not reliably give us a structured user
      // message at submit time the way Claude does. Seed the
      // feed immediately from the local composer state so
      // "submit" is visible even if rollout JSON is late.
      workspace.addOptimisticCodexUserEntry(sessionId, input)
    }

    try {
      const hasClaudeImages = submitProvider === 'claude' && draftImages.length > 0
      // Three submit modes live here because the two providers'
      // input stacks are similar but NOT equivalent:
      //
      //   1. Codex: always bracketed-paste, always trailing
      //      Enter outside the paste block, both in one write.
      //      This is the path that fixed Codex swallowing `\r`
      //      as pasted text.
      //
      //   2. Claude, normal text: raw text + `\r` in one write.
      //      Fast path for the overwhelmingly common case.
      //
      //   3. Claude, paste-like text (multiline OR long enough
      //      to hit Claude's own paste path): bracketed paste
      //      first, THEN a delayed `\r` in a second write. This
      //      is the critical fix for the "first Enter populates
      //      the prompt but does not actually submit; second
      //      Enter finally sends it" bug.
      const isClaudePasteLike =
        submitProvider === 'claude' &&
        (input.includes('\n') || input.length > CLAUDE_PASTE_THRESHOLD)

      if (submitProvider === 'codex') {
        // Codex's own bracketed-paste handling does NOT exhibit the
        // race Claude does (the user has not reported a Codex paste-
        // submit bug). No event-driven path here; pasteId is still
        // forwarded so the debug dump can confirm "ah, this Enter
        // routed to the Codex branch" if the failing dump is on a
        // Codex pane and we were debugging the wrong thing.
        window.api.recordPasteDebugEvent(pasteId, {
          layer: 'RENDER',
          event: 'route:codex-bracketed-paste',
        })
        await sendBracketedPasteThenSubmit(send, input, 0, { pasteId })
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
          // Claude collapses the following path paste into
          // image pills. If the user's prompt ends in a
          // non-whitespace character, inject one separator so
          // the final prompt text does not run directly into
          // the first `[Image #N]` placeholder.
          if (!/\s$/.test(input)) await send(' ')
        }
        const payload = buildClaudeImagePastePayload('', imagePaths)
        window.api.recordPasteDebugEvent(pasteId, {
          layer: 'RENDER',
          event: 'route:claude-images',
          data: { imageCount: imagePaths.length, textLen: input.length },
        })
        // Image-path paste uses the longer 750 ms timer because the
        // image expansion in Claude's TUI is its own animation; the
        // placeholder we detect for text pastes does NOT show up
        // for image-path pastes. Keep the wall-clock fallback here;
        // event-driven path is disabled for this branch on purpose.
        await sendBracketedPasteThenSubmit(send, payload, CLAUDE_IMAGE_PATH_SUBMIT_DELAY_MS, { pasteId })
      } else if (isClaudePasteLike) {
        // Keep the submit key OUT of the bracketed-paste write
        // and wait past Claude's paste debounce. Sending `\r`
        // in the same PTY chunk races Claude's paste
        // accumulator and can leave the prompt sitting in the
        // composer until a later keypress nudges it through
        // the normal submit path.
        //
        // Claude paste-like text always takes the event-driven path:
        // wait until the TUI has visibly committed the paste placeholder,
        // then send Enter. The old 125 ms timer is not a setting because
        // real production traces showed it races Claude's accumulator; it
        // remains only as an internal fallback when placeholder detection
        // cannot run or times out. See claudePaste.ts.
        window.api.recordPasteDebugEvent(pasteId, {
          layer: 'RENDER',
          event: 'route:claude-paste-like',
          data: {
            inputLen: input.length,
            hasNewline: input.includes('\n'),
            eventDriven: true,
          },
        })
        await sendBracketedPasteThenSubmit(send, input, CLAUDE_PASTE_SUBMIT_DELAY_MS, {
          pasteId,
          // Content-match submit: confirm Claude's composer actually shows the
          // paste (placeholder OR inlined text) before sending Enter, via the
          // live screen snapshot. No clock as the primary path. See #279 / #90.
          eventDriven: {
            enabled: true,
            getScreen: () => workspace.latestScreenRef.current[sessionId],
          },
        })
      } else {
        window.api.recordPasteDebugEvent(pasteId, {
          layer: 'RENDER',
          event: 'route:claude-plain-text',
          data: { inputLen: input.length },
        })
        await send(input + '\r', pasteId)
      }
      setInputText('')
      if (submitProvider === 'claude' && draftImages.length > 0) {
        workspace.setDraftImages(sessionId, [])
      }
      // OUTCOME marks the end of the submit flow from the renderer's
      // POV. A real reader of the dump can compare this against
      // PTY:main:write events to see whether the renderer thinks
      // the submit completed at the same instant main does.
      window.api.recordPasteDebugEvent(pasteId, {
        layer: 'OUTCOME',
        event: 'submit:returned',
      })
    } catch (err) {
      // Keep the draft visible if main no longer has a live
      // session for this pane. Clearing the composer on a
      // dropped write makes the failure look like Codex ignored
      // the prompt when it never received it.
      if (submitProvider === 'codex') {
        workspace.removeOptimisticCodexUserEntry(sessionId, input)
      }
      console.warn('[TileLeaf] submit failed', err)
      window.api.recordPasteDebugEvent(pasteId, {
        layer: 'ERROR',
        event: 'submit:throw',
        data: { message: err instanceof Error ? err.message : String(err) },
      })
    }
    // Any submit exits history cycling — the prompt is
    // committed and the next Up should start a fresh walk from
    // the (now updated) newest entry, not continue from
    // wherever we were.
    endHistoryCycle()
  }

  const onKeyDown = async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Global keybinds bubble up to the document-level listener in
    // useKeybinds; if a modifier-combo handler called
    // preventDefault already, skip processing here to avoid
    // routing pane-management keys into the PTY as text.
    if (e.defaultPrevented) return

    if (
      workspace.dispatchMode &&
      e.altKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      (e.key === 'ArrowUp' || e.key === 'ArrowDown')
    ) {
      // WHY let this bubble instead of handling it here: Dispatch Mode uses
      // Option+Arrow as list navigation. The selected agent pane is rendered
      // focused, which means its composer owns DOM focus while the user is
      // only browsing the Dispatch list. If the composer consumes the chord,
      // the fallback arrow path below sends an escape sequence to the agent;
      // `send()` correctly acknowledges real input, but here that would clear
      // NEW just by moving through the list. Returning preserves the event for
      // the global Dispatch keybind and prevents pane input/acknowledgement.
      return
    }

    // ---- Slash mode entry ----
    //
    // Only when input is empty AND the user types `/`. That way
    // normal text containing a `/` in the middle (a URL, a path)
    // doesn't accidentally flip us into slash mode.
    if (!slashMode && backendReady && input === '' && e.key === '/') {
      e.preventDefault()
      await send('/')
      setInputText('/')
      setSlashMode(true)
      return
    }

    // ---- Slash mode: forward every key to PTY ----
    if (slashMode) {
      e.preventDefault()
      if (!backendReady) {
        blockBackendWrite()
        exitSlashMode()
        return
      }

      if (e.key === 'Escape') {
        // Send ESC to CC (dismisses the picker) and exit slash
        // mode. slashMode is intentionally flipped off BEFORE the
        // picker's next screen update arrives — we don't want to
        // wait for CC to confirm the dismissal before letting the
        // user type.
        await send('\x1b')
        exitSlashMode()
        return
      }
      if (e.key === 'Enter') {
        // Commit whatever CC has highlighted. If there's no
        // highlight CC will just send the literal text as a
        // regular prompt.
        workspace.clearPendingRewindUndo(sessionId)
        await send('\r')
        exitSlashMode()
        return
      }
      if (e.key === 'Backspace') {
        await send('\x7f')
        const next = input.slice(0, -1)
        setInputText(next)
        // If the user backspaces all the way out, we're no longer
        // in slash mode — fall back to the normal composer.
        if (next === '') setSlashMode(false)
        return
      }
      if (e.key === 'ArrowUp') { await send('\x1b[A'); return }
      if (e.key === 'ArrowDown') { await send('\x1b[B'); return }
      if (e.key === 'ArrowLeft') { await send('\x1b[D'); return }
      if (e.key === 'ArrowRight') { await send('\x1b[C'); return }
      if (e.key === 'Tab') { await send('\t'); return }
      // Single printable char: forward + mirror into local state
      // so the React input visibly tracks what CC has in its
      // buffer.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        await send(e.key)
        setInputText(input + e.key)
        return
      }
      // Ignore shift, ctrl, meta, function keys, etc. while in
      // slash mode.
      return
    }

    // ---- Normal mode ----
    //
    // Shift+Enter: insert a literal newline in the composer
    // (normal textarea behavior). We DON'T preventDefault so the
    // browser handles the insertion, and we don't forward anything
    // to the PTY — the newline only becomes visible to CC when the
    // user commits with a bare Enter below. This gives multi-line
    // prompt editing without touching the PTY until the user
    // actually wants to send.
    if (e.key === 'Enter' && e.shiftKey) return

    if (e.key === 'Enter') {
      e.preventDefault()
      await submitCurrentDraft('textarea-enter', e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (!backendReady) {
        blockBackendWrite()
        return
      }
      await send('\x1b')
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      if (!backendReady) {
        blockBackendWrite()
        return
      }
      await send('\x03')
      setInputText('')
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      if (!backendReady) {
        blockBackendWrite()
        return
      }
      await send('\x04')
      return
    }

    // ---- Prompt history: Up cycles BACKWARD into past prompts ----
    //
    // Entry gate: we ONLY enter cycling when the composer is
    // currently empty. That's deliberately more restrictive than
    // bash's "cycle even with a partial draft and restore on
    // Down". The permissive version caused real confusion —
    // users pressing Up with a mid-typed prompt would watch their
    // draft get replaced with a random historic prompt and think
    // something was injecting text into their input. The anchor-
    // restore mechanism was there but non-obvious. Requiring an
    // empty composer makes the feature discoverable and non-
    // destructive: you have to actively clear your input before
    // you can cycle.
    //
    // Once cycling has STARTED (historyIndex !== null),
    // subsequent Up/Down steps don't re-check emptiness — the
    // composer is showing a historic prompt, not user typing, so
    // stepping further is obviously safe.
    //
    // Modifier combos (Shift/Ctrl/Meta/Alt+Up) fall through to
    // the PTY-forward path so OS line-navigation shortcuts still
    // reach CC when the user wants them.
    //
    // Skip history cycling when the approval overlay is visible —
    // arrow keys need to reach the PTY so Codex can navigate its
    // selection list.
    if (
      e.key === 'ArrowUp' &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !hasBlockingCondition &&
      history.length > 0 &&
      (cyclingHistory || input === '')
    ) {
      e.preventDefault()
      if (!cyclingHistory) {
        // First entry into cycling: the composer is empty (per
        // the gate above), so the anchor is also empty. Storing
        // it anyway keeps the Down-past-newest restore path
        // uniform.
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
    // outside a cycle shouldn't do anything (no forward history
    // to cycle to). We also don't need the cursorOnBottomRow
    // check the old version had, because the composer's content
    // during cycling is a historic prompt the user hasn't touched
    // — there's no multi-line-draft caret navigation to preserve.
    if (
      e.key === 'ArrowDown' &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !hasBlockingCondition &&
      cyclingHistory
    ) {
      e.preventDefault()
      const next = historyIndex! - 1
      if (next < 0) {
        // Past the newest historic prompt — restore the anchor
        // (empty, since the Up gate only lets us in from an empty
        // composer) and exit cycle mode so the next Up starts
        // fresh.
        setHistoryIndex(null)
        setInputText(historyAnchor)
      } else {
        setHistoryIndex(next)
        setInputText(history[next])
      }
      return
    }

    // ---- Up/Down fallback after the prompt-history gates ----
    //
    // History cycling above is intentionally gated on an empty
    // composer (#116 design note: the bash-style "cycle into past
    // prompts even with a partial draft" was rejected as confusing —
    // see the cycling block above). The OLD fallback here forwarded
    // every plain ArrowUp/Down to the PTY as `\x1b[A` / `\x1b[B`,
    // which meant typing into a multi-line draft and trying to move
    // the caret up didn't move the caret — it sent an arrow escape
    // to the backend instead, while the textarea sat motionless. The
    // composer behaved like a one-line input model even though the
    // textarea was perfectly capable of multi-line editing.
    //
    // The new shape preserves three real use cases and drops the
    // fourth (vestigial) one:
    //
    //   1. Blocking conditions (approval overlay etc.) still need
    //      arrows to reach the backend, because the overlay UX is
    //      driven by the TUI selection menu underneath. Same
    //      preventDefault + send as before.
    //   2. Empty composer + ArrowUp/Down (and not cycling, e.g.
    //      because history is empty) → forward to backend. Some
    //      providers care; we never want to fight them when there's
    //      literally nothing in the composer to navigate within.
    //   3. Modifier combos (Shift/Ctrl/Cmd/Alt + Up/Down) are
    //      deliberately NOT handled here anymore. The previous code
    //      forwarded them to the PTY under the theory of "OS line-
    //      navigation shortcuts reaching CC." In practice that broke
    //      the OS expectation that Cmd+ArrowUp jumps the caret to
    //      the top of the textarea on macOS, which is exactly what
    //      a user editing a long draft expects. Letting the browser
    //      handle modifier combos restores both that expectation
    //      and the rest of the standard caret-navigation suite.
    //   4. (Dropped) plain ArrowUp/Down with content present → no
    //      longer preventDefault'd. Browser handles it natively, so
    //      the caret moves up/down within the multi-line draft.
    //
    // We can re-add modifier-forwarding later if a specific provider
    // breaks, but for the current Claude/Codex headless backends the
    // PTY is not consuming arrow escapes from the composer at all.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const seq = e.key === 'ArrowUp' ? '\x1b[A' : '\x1b[B'
      if (hasBlockingCondition) {
        e.preventDefault()
        if (!backendReady) { blockBackendWrite(); return }
        await send(seq)
        return
      }
      if (input === '' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        if (!backendReady) { blockBackendWrite(); return }
        await send(seq)
        return
      }
      // Composer has content (or a modifier is held): let the
      // browser handle it — caret moves up/down within the textarea,
      // Cmd+ArrowUp jumps to the start, etc.
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      if (!backendReady) { blockBackendWrite(); return }
      await send('\t')
      return
    }
  }

  return { onKeyDown, slashMode, submitCurrentDraft }
}
