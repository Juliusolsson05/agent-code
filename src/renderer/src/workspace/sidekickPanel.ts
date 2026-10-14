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
