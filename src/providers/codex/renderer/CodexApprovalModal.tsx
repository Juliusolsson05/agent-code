import { useCallback, useEffect, useState } from 'react'

// CodexApprovalPane — inline approval prompt rendered inside the pane,
// matching how Codex's TUI draws it in the bottom pane.
//
// Layout (from codex-rs/tui/src/bottom_pane/approval_overlay.rs and
// real screen recordings):
//   Title (bold): "Would you like to run the following command?"
//   Reason: <explanation>
//   $ <command>
//   › 1. Yes, proceed (y)
//     2. Yes, and don't ask again for commands that start with `git add` (p)
//     3. No, and tell Codex what to do differently (esc)
//   Press enter to confirm or esc to cancel
//
// Options and selection state are parsed from the live screen buffer
// by detectCodexApproval(), so our UI mirrors the real TUI exactly —
// including dynamic option text and the current selection position.

type Props = {
  approval: {
    callId: string | null
    command: string[]
    workdir: string | null
    reason?: string | null
    options?: string[]
    selectedIndex?: number
  } | null
  onSend: (data: string) => Promise<void>
}

// Fallback options when screen parsing doesn't extract them.
const DEFAULT_OPTIONS = [
  'Yes, proceed',
  "Yes, and don't ask again",
  'No, and tell Codex what to do differently',
]

const DEFAULT_HINTS = ['y', 'p', 'esc']

// Map selected option index → PTY keystroke.
// Index 0 = Enter (confirm default), 1 = 'p', 2 = Esc.
const OPTION_KEYS = ['\r', 'p', '\x1b']

export function CodexApprovalModal({ approval, onSend }: Props) {
  const [localSelected, setLocalSelected] = useState(0)

  // Sync local selection from screen-parsed selection state.
  // The screen parser tracks which option has the `›` marker.
  useEffect(() => {
    if (approval?.selectedIndex != null) {
      setLocalSelected(approval.selectedIndex)
    }
  }, [approval?.selectedIndex])

  // Reset selection when a new approval appears.
  useEffect(() => {
    if (approval) setLocalSelected(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval?.command?.join(' ')])

  const options = approval?.options?.length
    ? approval.options
    : DEFAULT_OPTIONS

  const confirm = useCallback(() => {
    const key = OPTION_KEYS[localSelected] ?? '\r'
    void onSend(key)
  }, [localSelected, onSend])

  const cancel = useCallback(() => {
    void onSend('\x1b')
  }, [onSend])

  // Capture keyboard while approval is visible. Uses capture phase
  // so we intercept before the composer's onKeyDown.
  useEffect(() => {
    if (!approval) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        // Send arrow key to PTY so Codex also moves its selection.
        void onSend('\x1b[A')
        setLocalSelected(prev => Math.max(0, prev - 1))
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        void onSend('\x1b[B')
        setLocalSelected(prev => Math.min(options.length - 1, prev + 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        confirm()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancel()
        return
      }
      // Shortcut keys
      if (e.key === 'y') { e.preventDefault(); e.stopPropagation(); void onSend('\r'); return }
      if (e.key === 'p') { e.preventDefault(); e.stopPropagation(); void onSend('p'); return }
      if (e.key === 'n') { e.preventDefault(); e.stopPropagation(); void onSend('\x1b'); return }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [approval, options.length, confirm, cancel, onSend])

  if (!approval) return null

  const command = approval.command.join(' ').trim()

  return (
    <div className="
      flex-shrink-0
      border-t border-border
      bg-surface
      px-5 py-3
      font-code text-[12px] leading-[1.65]
    ">
      {/* Title */}
      <div className="text-ink font-semibold mb-2">
        Would you like to run the following command?
      </div>

      {/* Reason — parsed from the screen's "Reason: <text>" line */}
      {approval.reason && (
        <div className="text-ink-dim italic mb-2">
          Reason: {approval.reason}
        </div>
      )}

      {/* Command */}
      {command && (
        <div className="mb-2">
          <span className="text-muted select-none">$ </span>
          <span className="text-accent">{command}</span>
        </div>
      )}

      {/* Options — mirrors the live screen selection. The `›` marker
          and option text come from the screen parser so dynamic labels
          (like "don't ask again for commands that start with `git add`")
          render correctly. */}
      <div className="flex flex-col gap-0.5 mb-2">
        {options.map((opt, i) => (
          <div
            key={i}
            className={`cursor-pointer ${i === localSelected ? 'text-ink' : 'text-ink-dim'}`}
            onClick={() => { setLocalSelected(i); void onSend(OPTION_KEYS[i] ?? '\r') }}
          >
            <span className={`select-none ${i === localSelected ? 'text-accent' : 'text-transparent'}`}>
              ›{' '}
            </span>
            {i + 1}. {opt}
            <span className="text-muted ml-1">({DEFAULT_HINTS[i] ?? ''})</span>
          </div>
        ))}
      </div>

      {/* Footer hint */}
      <div className="text-muted text-[10px]">
        Press enter to confirm or esc to cancel
      </div>
    </div>
  )
}
