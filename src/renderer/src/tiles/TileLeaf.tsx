import { useEffect, useRef, useState } from 'react'

import { extractAssistantInProgress } from '../../../core/parsers/streamingScreen'
import { Feed } from '../feed/Feed'
import { TrustDialogModal } from '../feed/TrustDialogModal'
import type { SessionRuntime, Workspace } from './workspaceStore'
import type { SessionId } from './types'

// TileLeaf — one pane. A "mini cc-shell" self-contained in a box:
//   header strip (title + close + status)
//   Feed (structured JSONL + streaming preview)
//   composer (input box routing keystrokes to this pane's session)
//   trust dialog overlay (scoped to this pane, not window-global)
//
// All per-session state is passed in through the `runtime` prop — this
// component never touches window.api directly except for sendInput.
// That's the boundary: the store owns event subscriptions + mutations,
// TileLeaf owns rendering and keyboard input for its specific session.

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

  // When focus flips to this pane, move the DOM caret into its input.
  useEffect(() => {
    if (focused) inputRef.current?.focus()
  }, [focused])

  const send = async (data: string) => {
    await window.api.sendInput(sessionId, data)
  }

  const onKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Global keybinds bubble up to the document-level listener in
    // useKeybinds; if a modifier-combo handler called preventDefault
    // already, the KeyboardEvent.defaultPrevented flag is set and we
    // skip processing it here to avoid routing pane-management keys
    // into the PTY as text.
    if (e.defaultPrevented) return

    if (e.key === 'Enter') {
      e.preventDefault()
      // Capture streaming baseline from the very freshest screen text
      // so the streaming card can detect "this is the old response"
      // reliably. latestScreenRef is mutated synchronously on every IPC
      // screen event so this is always current.
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
      <div className="flex-shrink-0 border-t border-border bg-surface px-3 py-2">
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
            onChange={e => setInputText(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={onFocusRequest}
            placeholder={focused ? 'type and press enter…' : ''}
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
