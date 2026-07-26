import type { CommandState } from '@renderer/features/command-palette/types'

// ---------------------------------------------------------------------------
// Semantic command state (governance plan, Phase 6).
//
// The old shape was `{ label: string; tone?: 'neutral'|'accent'|'danger' }`,
// and the renderer uppercased every label into one chip. That cannot express
// whether the text is a boolean, a selected value, contextual information,
// EFFECTIVE-versus-owned truth, an unavailable capability, or async progress —
// so the audit found all six being rendered identically:
//
//   - Tail showed "On (all)", a state invoking Tail cannot turn off, because
//     it is owned by Tail All.
//   - Caffeinate showed "Unsupported" as if it were an ordinary value.
//   - usage.cycle-header-level rendered the RAW lowercase enum ("providers").
//   - Dangerous Agents said "On" before the fleet reload implementing it had
//     finished.
//   - Provider names on Reload/Switch/Copy Resume are CONTEXT, not state, but
//     were styled like an enabled toggle.
//   - MCP toggles and reload had no pending state at all, so a slow operation
//     looked like nothing had happened.
//
// TONE IS DERIVED, never authored. That is the constraint that makes the whole
// thing hold: a caller cannot say "this is danger-coloured" independently of
// what it means, so colour and meaning cannot drift apart.
// ---------------------------------------------------------------------------

/**
 * Where a state's truth comes from.
 *
 * `persisted` — a stored preference. `runtime` — live process/session state.
 * `effective` — what the user actually experiences, which may be produced by
 * something OTHER than this command. Tail is the motivating case: it reports
 * `effective` on, because Tail All is what turned it on and only Tail All can
 * turn it off.
 */
export type CommandStateTruth = 'persisted' | 'runtime' | 'effective'

/** A boolean capability or preference. */
export function toggle(
  value: boolean | 'mixed',
  options: { truth?: CommandStateTruth; detail?: string } = {},
): CommandState {
  return {
    kind: 'toggle',
    value: value === 'mixed' ? 'mixed' : value ? 'on' : 'off',
    truth: options.truth ?? 'runtime',
    ...(options.detail ? { detail: options.detail } : {}),
  }
}

/**
 * A panel's open/closed state.
 *
 * Distinct from `toggle` only in vocabulary. The audit found panels split
 * between "On/Off" and "Open/Closed" with no rule; a panel is open or closed,
 * and having one constructor per vocabulary is what stops the drift returning.
 */
export function panel(
  open: boolean,
  options: { detail?: string } = {},
): CommandState {
  return {
    kind: 'toggle',
    value: open ? 'on' : 'off',
    truth: 'runtime',
    vocabulary: 'open-closed',
    ...(options.detail ? { detail: options.detail } : {}),
  }
}

/**
 * A selected option, or contextual information about the target.
 *
 * Provider badges on Reload/Switch/Copy Resume belong here: they say WHICH
 * provider the command would act on, and must never be read as enabled.
 */
export function value(
  label: string,
  options: { truth?: CommandStateTruth; detail?: string } = {},
): CommandState {
  return {
    kind: 'value',
    label,
    truth: options.truth ?? 'runtime',
    ...(options.detail ? { detail: options.detail } : {}),
  }
}

/**
 * Async progress, an unsupported capability, or a failure.
 *
 * `unavailable` is FIRST-CLASS rather than a value whose text happens to read
 * "Unsupported" — that distinction is what lets the picker grey a row instead
 * of offering it as ordinary and executable.
 */
export function status(
  value: 'loading' | 'unavailable' | 'error',
  detail: string,
): CommandState {
  return { kind: 'status', value, detail }
}

export type CommandStatePresentation = {
  label: string
  tone: 'neutral' | 'accent' | 'danger'
  /** Longer explanation for a tooltip or details pane. */
  detail?: string
  /** True when the row should render as disabled. */
  muted: boolean
}

/**
 * The single place a semantic state becomes pixels.
 *
 * Every surface — palette row, preview pane, Settings — calls this, so a state
 * cannot be coloured one way in one place and another elsewhere. Deriving the
 * tone here is what enforces "tone is not authored".
 */
export function describeCommandState(state: CommandState): CommandStatePresentation {
  switch (state.kind) {
    case 'toggle': {
      const openClosed = state.vocabulary === 'open-closed'
      if (state.value === 'mixed') {
        return {
          label: openClosed ? 'Mixed' : 'Mixed',
          // Accent, not neutral: mixed means SOMETHING is on, and rendering it
          // like off would tell the user the opposite of what is happening.
          tone: 'accent',
          detail: state.detail,
          muted: false,
        }
      }
      const on = state.value === 'on'
      return {
        label: openClosed ? (on ? 'Open' : 'Closed') : on ? 'On' : 'Off',
        tone: on ? 'accent' : 'neutral',
        detail: state.detail,
        muted: false,
      }
    }
    case 'value':
      // Always neutral. A context value is not an enabled state, and colouring
      // it like one is precisely how provider badges came to look like toggles.
      return { label: state.label, tone: 'neutral', detail: state.detail, muted: false }
    case 'status':
      return {
        label: STATUS_LABELS[state.value],
        tone: state.value === 'error' ? 'danger' : 'neutral',
        detail: state.detail,
        // Loading and unavailable both read as "you cannot act on this right
        // now", which is a visual property of the row, not of its text.
        muted: state.value !== 'error',
      }
  }
}

const STATUS_LABELS: Record<'loading' | 'unavailable' | 'error', string> = {
  loading: 'Working…',
  unavailable: 'Unavailable',
  error: 'Failed',
}
