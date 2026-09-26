import { useCallback, useEffect, useRef, useState } from 'react'
import { withVisibleControls } from '@shared/text/visibleControls'
import { ConditionOptionList } from '@providers/shared/renderer/conditions/ConditionOptionList'

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
  interactionActive: boolean
}

// Fallback options when screen parsing doesn't extract them.
const DEFAULT_OPTIONS = [
  'Yes, proceed',
  "Yes, and don't ask again",
  'No, and tell Codex what to do differently',
]

// Canonical bindings, shown as chips on the rows. They are the keys the strip's
// handler below forwards (y → Enter, p, Escape/n), so a chip never names a
// key that does nothing.
const DEFAULT_HINTS = ['Y', 'P', 'Escape']

// Map selected option index → PTY keystroke.
// Index 0 = Enter (confirm default), 1 = 'p', 2 = Esc.
const OPTION_KEYS = ['\r', 'p', '\x1b']

export function CodexApprovalModal({ approval, onSend, interactionActive }: Props) {
  const [localSelected, setLocalSelected] = useState(0)
  // The option LIST is the focus owner (aria-activedescendant); its keys
  // bubble to the strip's handler below.
  const listRef = useRef<HTMLDivElement>(null)
  const interactionActiveRef = useRef(interactionActive)
  interactionActiveRef.current = interactionActive

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

  useEffect(() => {
    if (!approval || !interactionActive) return
    const frame = requestAnimationFrame(() => {
      if (interactionActiveRef.current) listRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
    // Provider snapshots rebuild `approval` as a fresh object. Key on the
    // approval's semantic identity so an unrelated snapshot/selection update
    // cannot keep pulling focus back to this strip.
  }, [approval?.callId, approval?.command.join('\0'), interactionActive])

  if (!approval) return null

  // Escape BEFORE trimming, never after. `./check.sh\r` is a filename whose
  // last byte is CR — the exact trick #1049 exists to expose — and `.trim()`
  // removes CR, so trimming first deleted the evidence and left two different
  // commands rendering identically (#1049 re-review). After escaping, the CR
  // is the visible text `⟨U+000D CR⟩`, which trim leaves alone, and ordinary
  // surrounding whitespace is still tidied.
  const command = withVisibleControls(approval.command.join(' ')).trim()

  return (
    <div
      role="group"
      aria-label="Codex command approval options"
      onKeyDown={e => {
        // Pane-local ownership is load-bearing: an approval can remain visible
        // in a background split, but it must never capture another pane's
        // Enter/shortcut keys through a document listener.
        if (!interactionActive) return
        if (e.key === 'ArrowUp') {
          e.preventDefault(); e.stopPropagation()
          void onSend('\x1b[A')
          setLocalSelected(prev => Math.max(0, prev - 1))
        } else if (e.key === 'ArrowDown') {
          e.preventDefault(); e.stopPropagation()
          void onSend('\x1b[B')
          setLocalSelected(prev => Math.min(options.length - 1, prev + 1))
        } else if (e.key === 'Enter') {
          e.preventDefault(); e.stopPropagation(); confirm()
        } else if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation(); cancel()
        } else if (e.key === 'y') {
          e.preventDefault(); e.stopPropagation(); void onSend('\r')
        } else if (e.key === 'p') {
          e.preventDefault(); e.stopPropagation(); void onSend('p')
        } else if (e.key === 'n') {
          e.preventDefault(); e.stopPropagation(); void onSend('\x1b')
        }
      }}
      className="
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
          Reason: {withVisibleControls(approval.reason)}
        </div>
      )}

      {/* Command */}
      {command && (
        <div className="mb-2">
          <span className="text-muted select-none">$ </span>
          <span className="text-accent">{withVisibleControls(command)}</span>
        </div>
      )}

      {/* Options — mirrors the live screen selection. The `›` marker
          and option text come from the screen parser so dynamic labels
          (like "don't ask again for commands that start with `git add`")
          render correctly. */}
      <ConditionOptionList
        ref={listRef}
        label="Approval choices"
        marker="›"
        options={options.map((label, i) => ({ label: withVisibleControls(label), shortcut: DEFAULT_HINTS[i] }))}
        selectedIndex={localSelected}
        onChoose={i => { setLocalSelected(i); void onSend(OPTION_KEYS[i] ?? '\r') }}
      />
    </div>
  )
}
