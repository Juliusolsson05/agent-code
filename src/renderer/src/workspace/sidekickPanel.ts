import type { SidekickPanelState } from '@renderer/workspace/types'

// The Sidekick panel's per-window pointer (#1493): pure helpers shared by
// rehydrate (restoring it), the panel (resizing it) and tests.
//
// WHY clamping lives here and is applied on READ: the width arrives from
// workspace.json, which is hand-editable and survives display changes. A
// width that fit a 32" monitor would cover a laptop screen and leave the
// lanes zero pixels; a negative one would collapse the panel to nothing with
// no handle to drag back. Clamping at every read means no stored value can
// produce an unusable layout (plan Decision 7: ≥ 300 px, ≤ 60% of the window).

export const SIDEKICK_PANEL_DEFAULT_WIDTH = 420
export const SIDEKICK_PANEL_MIN_WIDTH = 300
export const SIDEKICK_PANEL_MAX_FRACTION = 0.6

export const DEFAULT_SIDEKICK_PANEL: SidekickPanelState = Object.freeze({
  open: false,
  width: SIDEKICK_PANEL_DEFAULT_WIDTH,
  sidekickId: null,
}) as SidekickPanelState

export function clampSidekickPanelWidth(width: number, windowWidth: number): number {
  const max = Math.max(SIDEKICK_PANEL_MIN_WIDTH, Math.floor(windowWidth * SIDEKICK_PANEL_MAX_FRACTION))
  if (!Number.isFinite(width)) return Math.min(SIDEKICK_PANEL_DEFAULT_WIDTH, max)
  return Math.min(max, Math.max(SIDEKICK_PANEL_MIN_WIDTH, Math.round(width)))
}

/** Read a persisted pointer defensively; anything malformed becomes the default. */
export function coerceSidekickPanel(raw: unknown): SidekickPanelState | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_SIDEKICK_PANEL }
  const value = raw as Record<string, unknown>
  return {
    open: value.open === true,
    width: typeof value.width === 'number' && Number.isFinite(value.width) ? value.width : SIDEKICK_PANEL_DEFAULT_WIDTH,
    sidekickId: typeof value.sidekickId === 'string' && value.sidekickId.length > 0 ? value.sidekickId : null,
  }
}

/**
 * Who the keyboard is commanding when the Sidekick owns it (#1493 follow-up:
 * "the sidekick must expose every feature a lane does").
 *
 * - `{ owns: false }` — the workspace owns the keyboard; the usual answer
 *   (takeover, then focused lane) applies.
 * - `{ owns: true, sessionId }` — the Sidekick owns it, and `sessionId` is the
 *   row this window holds for the panel's sidekick, or NULL when it holds none
 *   (asleep, live in another window, attaching, no sidekick yet).
 *
 * WHY null and never a fallback to the lane when the Sidekick owns the
 * keyboard but holds no row: the user is looking at the Sidekick. ⌘W, Reload
 * or Rewind landing on the lane agent behind it is exactly the silent
 * re-addressing #816 is about, so "nothing to command" is the honest answer.
 *
 * WHY Settings voids ownership: the Sidekick is retained-hidden under Settings
 * (SidekickPanelSurface), and Settings owns the interaction then.
 */
export function sidekickCommandTarget(
  state: { sidekickPanel?: SidekickPanelState; sessions: Record<string, { sidekickId?: string }> },
  flags: { keyboardRegion: 'workspace' | 'sidekick'; sidekickSpotlight: boolean; settingsPageOpen: boolean },
): { owns: false } | { owns: true; sessionId: string | null } {
  const panel = state.sidekickPanel
  const owns = panel?.open === true
    && !flags.settingsPageOpen
    && (flags.keyboardRegion === 'sidekick' || flags.sidekickSpotlight)
  if (!owns) return { owns: false }
  const sidekickId = panel.sidekickId
  if (!sidekickId) return { owns: true, sessionId: null }
  for (const [sessionId, meta] of Object.entries(state.sessions)) {
    if (meta.sidekickId === sidekickId) return { owns: true, sessionId }
  }
  return { owns: true, sessionId: null }
}
