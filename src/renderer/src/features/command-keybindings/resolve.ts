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

    // An array that contained ONLY malformed values becomes `[]`, which means
    // "explicitly unbound". That is the conservative reading: we know the user
    // edited this command, and silently restoring the shipped chord would
    // re-add a binding they had removed.
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
  // Those have no entry to start from, so they are added here. Context defaults
  // to 'global' because a command with no declared default also has no declared
  // context, and global is the strictest choice for collision purposes: it
  // overlaps everything, so the checker will flag any clash rather than miss one.
  for (const [commandId, bindings] of Object.entries(overrides)) {
    if (byCommand.has(commandId)) continue
    byCommand.set(commandId, { commandId, bindings, context: 'global', customized: true })
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
 * Apply a Settings edit, keeping the map sparse.
 *
 * Writing an override that equals the shipped default REMOVES the entry rather
 * than storing a redundant copy — otherwise a user who toggled a binding off
 * and back on would be silently pinned to this release's default forever,
 * which is the same bug the absent/empty distinction exists to prevent.
 */
export function setCommandKeybindings(
  overrides: CommandKeybindingOverrides,
  commandId: string,
  bindings: readonly Keybinding[],
  defaults: readonly CommandBindingDefault[] = buildDefaultKeybindings(),
): CommandKeybindingOverrides {
  const next = { ...overrides }
  const shipped = defaults.find(entry => entry.commandId === commandId)?.bindings ?? []

  if (sameBindings(shipped, bindings)) delete next[commandId]
  else next[commandId] = [...bindings]

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

/** Order matters: two bindings for one command are an ordered display list. */
function sameBindings(a: readonly Keybinding[], b: readonly Keybinding[]): boolean {
  return a.length === b.length && a.every((binding, index) => binding === b[index])
}
