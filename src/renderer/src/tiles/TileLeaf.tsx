import { useEffect, useRef, useState } from 'react'

import { extractAssistantInProgress } from '../../../core/parsers/streamingScreen'
import { Feed } from '../feed/Feed'
import { TrustDialogModal } from '../feed/TrustDialogModal'
import { SlashCommandPicker } from './SlashCommandPicker'
import type { SessionRuntime, Workspace } from './workspaceStore'
import type { SessionId } from './types'

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
  const inputRef = useRef<HTMLInputElement>(null)
  // Per-leaf input state — lives with the instance so the typed value
  // persists across unrelated re-renders of the parent.
  const [input, setInputText] = useState('')
  // True while we're forwarding keystrokes to the PTY for a slash
  // command. Controls key routing in onKeyDown and render of the
  // picker dropdown (we still render the dropdown from runtime.picker,
  // but we use slashMode to decide whether keys should be forwarded
  // vs. stored locally).
  const [slashMode, setSlashMode] = useState(false)

  // When focus flips to this pane, move the DOM caret into its input.
  useEffect(() => {
    if (focused) inputRef.current?.focus()
  }, [focused])

  const send = async (data: string) => {
    await window.api.sendInput(sessionId, data)
  }

  const exitSlashMode = () => {
    setSlashMode(false)
    setInputText('')
  }

  const onKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
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
    if (e.key === 'Enter') {
      e.preventDefault()
      // Capture streaming baseline from the very freshest screen text
      // so the streaming card can detect "this is the old response"
      // reliably. latestScreenRef is mutated synchronously on every
      // IPC screen event so this is always current.
      const screen = workspace.latestScreenRef.current[sessionId] ?? ''
      const baseline = extractAssistantInProgress(screen)
      workspace.setStreamingBaseline(sessionId, baseline)
      await send(input + '\r')
      setInputText('')
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

  return (
    <div
      className={`
        flex flex-col h-full min-h-0 min-w-0
        border ${focused ? 'border-accent' : 'border-border'}
        bg-canvas
      `}
      onMouseDown={onFocusRequest}
    >
      {/* Pane header: compact status strip */}
      <div className="flex items-center justify-between px-3 py-1 border-b border-border bg-surface text-[10px] text-muted font-code select-none">
        <span className="truncate" title={runtime.projectDir ?? 'no project dir'}>
          {shortenCwd(runtime.projectDir)}
        </span>
        <span
          className={`flex items-center gap-1 ${running ? 'text-ink-dim' : 'text-muted'}`}
        >
          <span
            className={`inline-block w-1 h-1 rounded-full ${
              running ? 'bg-accent' : 'bg-muted'
            } ${running && runtime.awaitingAssistant ? 'streaming-dot' : ''}`}
          />
          <span className="tabular-nums">
            {running ? 'live' : `exited ${runtime.exited}`}
          </span>
        </span>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-auto min-h-0">
        <Feed
          entries={runtime.entries}
          streamingScreen={runtime.awaitingAssistant ? runtime.screen : null}
          streamingScreenMarkdown={
            runtime.awaitingAssistant ? runtime.screenMarkdown : null
          }
          streamingBaseline={runtime.streamingBaseline}
          showSystemEvents={false}
        />
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 border-t border-border bg-surface px-3 py-2 relative">
        {/* SlashCommandPicker is absolutely positioned relative to this
            composer container so it floats above the input without
            shifting layout. */}
        <SlashCommandPicker state={runtime.picker} />

        <div className="relative">
          <div className="absolute left-2 top-1/2 -translate-y-1/2 text-accent text-[12px] pointer-events-none select-none">
            ❯
          </div>
          <input
            ref={inputRef}
            className={`
              w-full bg-canvas border
              ${focused ? 'border-accent' : 'border-border'}
              text-ink text-[12px]
              pl-6 pr-2 py-2 outline-none
              placeholder:text-muted
              transition-colors duration-150
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
            }}
            onKeyDown={onKeyDown}
            onFocus={onFocusRequest}
            placeholder={
              slashMode ? undefined : focused ? 'type and press enter…' : ''
            }
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>

      {/* Per-pane trust dialog: only shown if THIS pane's screen buffer
          contains the trust prompt. Other panes have their own modals. */}
      <TrustDialogModal screen={runtime.screen} onSend={send} />
    </div>
  )
}

function shortenCwd(cwd: string | null): string {
  if (!cwd) return '—'
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length <= 2) return '/' + parts.join('/')
  return '…/' + parts.slice(-2).join('/')
}
