import type { CommandDef, CommandPickerVisibility } from '@renderer/features/command-palette/types'

/**
 * Everything the visibility decision needs, and nothing else.
 *
 * WHY this is a narrow struct rather than the full `CommandContext`: the
 * Settings screen must render the same decision for every command WITHOUT a
 * live context (it has no focused session and no ui callback bag). Taking the
 * whole context would force Settings to synthesize a fake one, and a fake
 * context is exactly how presentation logic starts quietly depending on
 * workspace state it has no business reading.
 */
export type PickerVisibilityPolicy = {
  /** Sparse per-command overrides from `Settings.commandVisibilityOverrides`. */
  overrides: Record<string, boolean> | undefined
  /** Global "reveal everything" escape hatch. */
  showHiddenCommands: boolean
  /** Mirrors `Settings.navigationCommandsEnabled`. */
  navigationCommandsEnabled: boolean
}

/**
 * Does this command belong in the command-picker LIST?
 *
 * ============================ READ THIS =================================
 * This function answers a PRESENTATION question and nothing else. It is not
 * an authorization boundary, and wiring it into any execution path is a
 * regression, not a feature.
 *
 * The governance audit found the app had already broken that rule by accident:
 * the native File menu resolved its command ids against the picker-FILTERED
 * registry, so setting `commandVisibilityOverrides['new-tab'] = false` — a
 * purely cosmetic "don't clutter my palette" preference — silently disabled the
 * File → New Tab menu item. A user tidying their palette lost a capability, with
 * no error and no way to connect cause to effect.
 *
 * The rule, stated positively: a command hidden here remains fully executable
 * by keybinding, native menu, and programmatic dispatch. Hiding controls list
 * noise. Whether an invocation may proceed is decided by contextual admission
 * (`commandApplicable`) and, at the mutation boundary, by the command itself.
 * ========================================================================
 *
 * Resolution order (most specific wins):
 *   1. `showHiddenCommands` → everything visible (global escape hatch);
 *   2. a disabled command GROUP → every member absent, as a family;
 *   3. an explicit per-command override (`true`/`false`) → that value;
 *   4. otherwise the declared tier, where absence means `'default'`. Only
 *      `'default'` is shown; `advanced`/`experimental`/`debug` are hidden.
 *
 * WHY the group gate outranks the per-command override (step 2 before 3): the
 * group is a single product switch over a closed family. If an override could
 * pull one member back into the picker while the family is off, Settings would
 * be showing six individually actionable switches that appear able to
 * contradict their own parent — the classic "disabled parent, enabled child"
 * UI that leaves users unable to predict what they will get. Turning the group
 * on restores ordinary per-command control immediately.
 */
export function isVisibleInPicker(
  command: Pick<CommandDef, 'id' | 'pickerVisibility' | 'commandGroup'>,
  policy: PickerVisibilityPolicy,
): boolean {
  if (policy.showHiddenCommands) return true

  if (command.commandGroup === 'navigation' && !policy.navigationCommandsEnabled) return false

  // Optional-chain defensively: this runs inside the palette's first-render
  // useMemo, so if `overrides` is ever undefined (a persisted-settings shape
  // predating the field that slipped past coercion), a bare `[id]` index throws
  // and takes the WHOLE app to a black screen — the exact #249 launch
  // regression. A missing override map must degrade to "no override", never
  // crash the registry build.
  const override = policy.overrides?.[command.id]
  if (typeof override === 'boolean') return override

  return declaredTier(command) === 'default'
}

/** The command's declared tier, with the documented `absent ≡ 'default'` rule
 *  applied in ONE place so callers never re-implement the fallback and drift. */
export function declaredTier(
  command: Pick<CommandDef, 'pickerVisibility'>,
): CommandPickerVisibility {
  return command.pickerVisibility ?? 'default'
}
