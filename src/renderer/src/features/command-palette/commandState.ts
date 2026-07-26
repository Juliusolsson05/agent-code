import type { CommandState } from '@renderer/features/command-palette/types'

// ---------------------------------------------------------------------------
// Semantic command state (governance plan, Phase 6).
//
// The old shape was `{ label: string; tone?: 'neutral'|'accent'|'danger' }`,
// and the renderer uppercased every label into one chip. That cannot express
// whether the text is a boolean, a selected value, contextual information, an
// unavailable capability, or async progress — so the audit found all of them
// rendered identically:
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

// NOTE: there was a `CommandStateTruth` here ('persisted' | 'runtime' |
// 'effective'), threaded through `toggle` and `value` and stored on every
// state. Nothing ever read it — not `describeCommandState`, not the palette
// row, not Settings. Its motivating case (Tail reporting `effective` on,
// because only Tail All can turn it off) is real, but it is carried by the
// `detail` string, which IS rendered. A field that only ever gets written is
// not a distinction the app makes; it is a distinction someone intended to
// make. Removed until a surface actually renders differently for it.

/** A boolean capability or preference. */
export function toggle(
  value: boolean | 'mixed',
  options: { detail?: string } = {},
): CommandState {
  return {
    kind: 'toggle',
    value: value === 'mixed' ? 'mixed' : value ? 'on' : 'off',
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
  options: { detail?: string } = {},
): CommandState {
  return {
    kind: 'value',
    label,
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
      if (state.value === 'mixed') {
        return {
          // Same word in both vocabularies. It was written as a ternary with
          // identical branches, which reads as a deliberate distinction and is
          // not one — "Mixed" is right for both On/Off and Open/Closed.
          label: 'Mixed',
          // Accent, not neutral: mixed means SOMETHING is on, and rendering it
          // like off would tell the user the opposite of what is happening.
          tone: 'accent',
          detail: state.detail,
          muted: false,
        }
      }
      const on = state.value === 'on'
      const openClosed = state.vocabulary === 'open-closed'
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
