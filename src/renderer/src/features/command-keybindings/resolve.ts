import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import { tryNormalizeKeybinding } from '@renderer/features/command-keybindings/normalize'
import type { CommandBindingDefault } from '@renderer/features/command-keybindings/defaults'
import type { Keybinding } from '@renderer/features/command-keybindings/normalize'

/**
 * Persisted per-command binding overrides. SPARSE by design.
 *
 * The three states are distinct and all load-bearing:
 *
 *   absent      → inherit whatever this release ships
 *   `[]`        → EXPLICITLY UNBOUND; ship nothing, now or later
 *   non-empty   → replaces the shipped defaults entirely
 *
 * WHY "absent" and "empty" must not collapse into one thing: they answer
 * different questions. Absent means "I never touched this", so a future release
 * that improves the default is free to change it. Empty means "I deliberately
 * removed this chord", and a release that then handed the command a new default
 * would be overriding a decision the user made on purpose. Storing today's
 * default on first edit — the obvious shortcut — destroys that distinction for
 * every command the user ever opens.
 *
 * WHY Reset removes the entry rather than writing the current default into it:
 * same reason, from the other direction. Reset means "go back to inheriting",
 * not "pin me to whatever the default happens to be this week".
 */
export type CommandKeybindingOverrides = Record<string, Keybinding[]>

/**
 * Coerce a persisted override map.
 *
 * Unknown command ids are PRESERVED, not pruned. An id that names nothing today
 * may belong to an extension that is temporarily uninstalled, a provider whose
 * commands are not generated in this build, or a command a downgrade removed.
 * Deleting those opportunistically would silently discard a user's deliberate
 * binding the moment they ran an older build. Only explicitly retired
 * first-party ids get removed, and only through a named migration.
 */
export function coerceCommandKeybindingOverrides(value: unknown): CommandKeybindingOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const result: CommandKeybindingOverrides = {}
  for (const [commandId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entry)) continue

    const bindings: Keybinding[] = []
    for (const candidate of entry) {
      const normalized = tryNormalizeKeybinding(candidate)
      // Drop malformed entries rather than the whole command: a user with three
      // bindings and one corrupt value keeps the two that still parse.
      if (!normalized) continue
      if (!bindings.includes(normalized)) bindings.push(normalized)
    }

    // A NON-EMPTY array whose entries all failed to parse is corruption, not
    // intent, so the key is dropped entirely and the command inherits again.
    //
    // The earlier policy collapsed it to `[]` — "explicitly unbound" — on the
    // reasoning that the user had clearly edited this command. That reasoning
    // is self-defeating: a deliberate unbind already writes `[]`, which
    // round-trips identically under either policy, so the rule only ever fired
    // on values the user did NOT author in that shape. It made corruption
    // permanent and unrecoverable: run an older build whose parser lacks a key
    // token the newer one added, and the binding degrades to `[]`, which then
    // outranks the shipped default forever — Settings shows "Not assigned" for
    // a command nobody touched, and re-upgrading does not bring it back. The
    // same happened to any externally-authored value in display notation
    // (`['⌘T']`), which is exactly the form displayKeybinding emits.
    if (entry.length > 0 && bindings.length === 0) continue
    result[commandId] = bindings
  }
  return result
}

export type EffectiveBinding = {
  commandId: string
  bindings: readonly Keybinding[]
  context: CommandBindingDefault['context']
  /** True when the user has an override for this command. */
  customized: boolean
}

/**
 * The bindings that will ACTUALLY run, per command.
 *
 * This is the single source consumed by the palette's display, the Settings
 * rows, search metadata, accessibility text, and the runtime router. The
 * audit's core keybinding finding was that display and behavior were two
 * independent facts that could disagree; funnelling all five consumers through
 * one function is what makes "the shortcut shown is the shortcut that runs"
 * structurally true rather than a thing someone has to remember.
 */
export function resolveEffectiveKeybindings(
  overrides: CommandKeybindingOverrides,
  defaults: readonly CommandBindingDefault[] = buildDefaultKeybindings(),
  /**
   * Context for a command that ships no default, INJECTED rather than looked
   * up here.
   *
   * WHY injected: deriving it needs the command catalog, and importing the
   * catalog into this module creates a real initialization cycle —
   * catalog → paneCommands → the provider capability registry → back here —
   * which fails at module load with a TDZ error rather than at a call site.
   * Callers that already hold the catalog (Settings, the runtime router) pass
   * a resolver; everything else gets the strict 'global' default.
   */
  contextForCommand: (commandId: string) => CommandBindingDefault['context'] = () => 'global',
): EffectiveBinding[] {
  const byCommand = new Map<string, EffectiveBinding>()

  for (const entry of defaults) {
    const override = overrides[entry.commandId]
    byCommand.set(entry.commandId, {
      commandId: entry.commandId,
      bindings: override ?? entry.bindings,
      context: entry.context,
      customized: override !== undefined,
    })
  }

  // A user can bind a command that ships with NO default — most of the catalog.
  // Those have no default entry to inherit a context from, so it is derived
  // from the command's SURFACE instead of defaulting to 'global'.
  //
  // WHY not just 'global': global overlaps every context, so it is the
  // strictest choice for collision purposes — but strictest is not the same as
  // correct, and here it forbids legitimate customization the context matrix
  // explicitly promises. Concretely: unbind nav-up, then assign Alt+K to the
  // grid-only rotate-layout. Grid and Dispatch are mutually exclusive, so
  // reusing Dispatch's Alt+K is safe and the matrix says so — but a 'global'
  // context reports it as overlapping Dispatch and rejects the binding.
  for (const [commandId, bindings] of Object.entries(overrides)) {
    if (byCommand.has(commandId)) continue
    byCommand.set(commandId, {
      commandId,
      bindings,
      context: contextForCommand(commandId),
      customized: true,
    })
  }

  return [...byCommand.values()]
}

/** Effective bindings for one command, for a palette row or Settings row. */
export function effectiveBindingsFor(
  commandId: string,
  overrides: CommandKeybindingOverrides,
  defaults?: readonly CommandBindingDefault[],
): readonly Keybinding[] {
  const found = resolveEffectiveKeybindings(overrides, defaults).find(
    entry => entry.commandId === commandId,
  )
  return found?.bindings ?? []
}

/**
 * Apply a Settings edit.
 *
 * An explicit edit is RECORDED even when its value happens to equal today's
 * shipped default. An earlier version deleted the entry in that case, to avoid
 * pinning a user who toggled a binding off and straight back on.
 *
 * That optimization contradicts the plan's stated acceptance criterion —
 * "preserves explicit choices when a later release changes shipped defaults" —
 * and the criterion wins, because the failure it prevents is worse. Concretely:
 * a user deliberately keeps open-settings on Cmd+, using the editor; the entry
 * is deleted as redundant; a later release moves the default to Cmd+Alt+, and
 * the user's explicit choice is silently overwritten by a chord they never
 * chose. The cost of the other direction is only that an off/on round trip
 * leaves a harmless entry recording a real decision — and `resetCommandKeybindings`
 * is the documented way to go back to inheriting.
 */
export function setCommandKeybindings(
  overrides: CommandKeybindingOverrides,
  commandId: string,
  bindings: readonly Keybinding[],
  defaults: readonly CommandBindingDefault[] = buildDefaultKeybindings(),
): CommandKeybindingOverrides {
  const next = { ...overrides }
  next[commandId] = [...bindings]
  return next
}

/** Reset one command to inheriting the shipped default. */
export function resetCommandKeybindings(
  overrides: CommandKeybindingOverrides,
  commandId: string,
): CommandKeybindingOverrides {
  const next = { ...overrides }
  delete next[commandId]
  return next
}

