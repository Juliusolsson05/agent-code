// Detect CC's "Quick safety check" trust dialog from a screen snapshot.
//
// Why this is its own parser:
//   The trust dialog is a modal interactive screen CC shows when you start
//   a session in a directory it hasn't seen before. We need to handle it
//   in two completely different contexts:
//
//     1. The testbench — auto-accept it during scripted recordings so we
//        can capture the main UI without manual intervention.
//     2. cc-shell itself — recognize it and render a real React modal
//        the user can click, instead of leaving it as raw screen text.
//
//   Both use cases share the SAME detection logic. Putting it in
//   src/core/parsers/ means the React renderer and the Node testbench
//   both call into the same pure function and any improvements to the
//   detector benefit both. If this lived in either main/ or testbench/
//   we'd end up duplicating it the moment cc-shell needs the modal.
//
// Why string-match and not regex:
//   The dialog text is stable and English-only in the version of CC we're
//   targeting. A simple substring search is faster, more obvious, and
//   easier to extend than a regex. If CC ships localized versions later
//   we add the new strings to the marker arrays — no rewrite.
//
// Why the parser returns a structured value rather than just a boolean:
//   The cc-shell modal will eventually need the option labels to render
//   buttons. Returning `{ visible, options }` future-proofs that. The
//   testbench currently only consumes `visible` but ignores `options`
//   harmlessly.

export type TrustDialogState = {
  /** True if CC is currently showing the trust dialog. */
  visible: boolean
  /** The selectable options shown in the dialog (best-effort extraction). */
  options?: Array<{ key: string; label: string }>
  /** The directory CC is asking the user to trust, if we can extract it. */
  workspace?: string
}

// Distinctive substrings from the dialog. ALL of these must be present for
// us to declare a positive match — being conservative avoids false positives
// on assistant text that happens to mention "trust" or "workspace".
const REQUIRED_MARKERS = [
  'Accessing workspace:',
  'Yes, I trust this folder',
  'No, exit',
] as const

const NEGATIVE_RE = /[\u23F5\u23F6]/ // ⏵ markers only appear in the main UI status row, not the trust dialog

/**
 * Returns the trust-dialog state for a given screen snapshot.
 *
 * Pure function — no IO, no side effects, no Node APIs.
 *
 * Performance note: this gets called on every screen snapshot (~60Hz)
 * during recording, so it has to be cheap. The early return on the first
 * missing marker keeps the common case (dialog NOT visible) to one
 * substring search.
 */
export function detectTrustDialog(screen: string): TrustDialogState {
  if (!screen) return { visible: false }

  for (const marker of REQUIRED_MARKERS) {
    if (!screen.includes(marker)) return { visible: false }
  }

  // Belt and suspenders: if we see status-row markers in the same screen,
  // CC has already moved past the dialog. Treat as not visible. This guards
  // against the brief moment when the dialog is fading out and the main UI
  // is fading in — both could be present in scrollback for one frame.
  if (NEGATIVE_RE.test(screen)) return { visible: false }

  // Best-effort: extract the workspace path. CC renders it on its own line
  // immediately under "Accessing workspace:".
  let workspace: string | undefined
  const lines = screen.split('\n')
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].includes('Accessing workspace:')) {
      // Skip blank lines, take the next non-blank.
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const candidate = lines[j].trim()
        if (candidate) {
          workspace = candidate
          break
        }
      }
      break
    }
  }

  // The two options we know about. We hardcode rather than parse the
  // numbered list because the parse would be more brittle than the
  // hardcoded labels — and CC's dialog has had these exact two for
  // multiple versions running.
  const options = [
    { key: '1', label: 'Yes, I trust this folder' },
    { key: '2', label: 'No, exit' },
  ]

  return { visible: true, options, workspace }
}

/**
 * The keystroke sequence to ACCEPT the trust dialog. Pressing Enter
 * confirms the highlighted option (option 1, "Yes, I trust this folder")
 * because CC pre-selects it. We deliberately don't synthesize "1" + Enter
 * because if CC ever changes the default highlight, "Enter" still picks
 * the highlighted option correctly.
 */
export const TRUST_DIALOG_ACCEPT_KEYS = '\r'
