import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { deriveExtensionCommands, deriveExtensionKeybindings } from '@renderer/apps/host/derive'
import { useExtensionHost } from '@renderer/apps/host/ExtensionHostProvider'
import { PALETTE_SELF_EXCLUDED_COMMAND_IDS } from '@renderer/features/command-palette/commands/paletteCommands'
import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import type { BindingContext } from '@renderer/features/command-keybindings/defaults'
import {
  displayKeybinding,
  keybindingFromEvent,
} from '@renderer/features/command-keybindings/normalize'
import { findBindingOwners } from '@renderer/features/command-keybindings/reservations'
import {
  resetCommandKeybindings,
  resolveEffectiveKeybindings,
  setCommandKeybindings,
} from '@renderer/features/command-keybindings/resolve'
import type { Keybinding } from '@renderer/features/command-keybindings/normalize'
import type { CommandCategory } from '@renderer/features/command-palette/types'

// ---------------------------------------------------------------------------
// Commands & Shortcuts: the built-in keybinding editor (governance plan §4).
//
// Every surviving built-in command gets a row with zero, one, or several
// bindings. "Keybind control of all commands" means exactly that and no more —
// it does NOT mean turning every keyboard interaction into a command. Escape
// dismissal, picker navigation, numbered selection and split resizing stay
// contextual interactions; they appear here only as CONFLICT OWNERS, never as
// editable rows.
//
// WHY this does not reuse HotkeyInput: dictation captures modifier-only holds
// (bare Cmd is a legitimate push-to-talk binding) and commits them after a
// settle timer. A command chord fires on keydown and can never be
// modifier-only, so inheriting that policy would offer users bindings the
// router cannot match. The two capture surfaces share the normalizer, not the
// interaction model.
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  create: 'Create',
  navigate: 'Navigate',
  session: 'Session',
  'layout-dispatch': 'Layout & Dispatch',
  'editor-files': 'Editor & Files',
  'workspace-tools': 'Workspace Tools',
  preferences: 'Preferences',
  developer: 'Developer',
  extensions: 'Extensions',
}

/**
 * Display order. EXHAUSTIVE by type, deliberately.
 *
 * It was a plain `CommandCategory[]`, and grouping filtered to it — so a
 * command in a category nobody remembered to list here would not appear in
 * Settings at all, and therefore could not be rebound. A silent omission with
 * no error anywhere. `Record<CommandCategory, number>` makes adding a category
 * a compile error until it has a position.
 */
const CATEGORY_RANK: Record<CommandCategory, number> = {
  create: 0,
  navigate: 1,
  session: 2,
  'layout-dispatch': 3,
  'editor-files': 4,
  'workspace-tools': 5,
  preferences: 6,
  developer: 7,
  // Last: extension-contributed commands browse after every first-party group,
  // the same "third-party entries never above the app's own" ordering the palette
  // uses for extension commands.
  extensions: 8,
}

const CATEGORY_ORDER = (Object.keys(CATEGORY_RANK) as CommandCategory[])
  .sort((a, b) => CATEGORY_RANK[a] - CATEGORY_RANK[b])

type PendingConflict = {
  commandId: string
  binding: Keybinding
  /** Human-readable owners, for a message that NAMES them. */
  owners: string[]
  /** Command ids whose bindings an explicit Replace would remove. */
  replaceableCommandIds: string[]
  /**
   * True when at least one owner is a RESERVED interaction.
   *
   * Kept separate from `replaceableCommandIds` because the two are not
   * complementary: a chord can be held by both a command and Escape. Offering
   * Replace there stripped the command's binding and installed the user's —
   * and the chord still would not fire, because the reserved owner still had
   * it. A destructive edit that does not achieve the thing it was for.
   */
  hasReservedOwner: boolean
}

export function CommandKeybindingsRow() {
  const settings = useAppStore(state => state.settings)
  const setSettings = useAppStore(state => state.setSettings)

  // Extension commands, derived from installed MANIFESTS exactly as the palette
  // (CommandPalette.tsx) and the visibility list (SettingsPage.tsx) do — no bundle
  // is imported. Without this the editor iterated only builtInCommandCatalog, so an
  // extension command could be shown/hidden in the Commands list but never assigned
  // a key here. openApp is a no-op: the editor reads command metadata and never
  // invokes `run`. They are stamped with the 'extensions' category so the row
  // builder's category filter admits them and they group under their own heading.
  const installedExtensions = useAppStore(state => state.installedExtensions)
  const extensionHost = useExtensionHost()
  const extensionCommands = useMemo(
    () =>
      (extensionHost ? deriveExtensionCommands(extensionHost, installedExtensions, () => {}) : [])
        .map(command => ({ ...command, category: 'extensions' as const })),
    [extensionHost, installedExtensions],
  )

  const [query, setQuery] = useState('')
  const [capturingFor, setCapturingFor] = useState<string | null>(null)
  const [conflict, setConflict] = useState<PendingConflict | null>(null)

  const overrides = settings.commandKeybindingOverrides
  // Shipped defaults + extension-contributed defaults, so the editor shows an
  // extension's declared chord as its default and conflict-checks against it —
  // the same combined table the router fires from (useKeybinds.ts).
  const defaults = useMemo(
    () => [...buildDefaultKeybindings(), ...deriveExtensionKeybindings(installedExtensions)],
    [installedExtensions],
  )

  const effective = useMemo(() => {
    const map = new Map<string, readonly Keybinding[]>()
    for (const entry of resolveEffectiveKeybindings(overrides, defaults)) {
      map.set(entry.commandId, entry.bindings)
    }
    return map
  }, [overrides, defaults])

  /** Effective set as default-shaped entries, so conflict lookup sees what the
   *  user's profile ACTUALLY runs rather than what shipped. Settings must catch
   *  a clash with the user's own rebinding, not just with the shipped table. */
  const effectiveAsDefaults = useMemo(
    () => resolveEffectiveKeybindings(overrides, defaults),
    [overrides, defaults],
  )

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return [...builtInCommandCatalog, ...extensionCommands]
      // A command the palette never renders still gets a binding row — it is
      // reachable by chord, menu and programmatic call, so it is bindable.
      .filter(command => command.category)
      .map(command => ({
        id: command.id,
        title: typeof command.title === 'function' ? command.id : command.title,
        category: command.category as CommandCategory,
        description: command.description,
        keywords: command.keywords ?? [],
        bindings: effective.get(command.id) ?? [],
        customized: overrides[command.id] !== undefined,
      }))
      .filter(row => {
        if (!needle) return true
        const haystack = [
          row.title,
          row.id,
          row.description,
          ...row.keywords,
          ...row.bindings.map(displayKeybinding),
        ].join(' ').toLowerCase()
        return haystack.includes(needle)
      })
  }, [query, effective, overrides, extensionCommands])

  const grouped = useMemo(() => {
    const byCategory = new Map<CommandCategory, typeof rows>()
    for (const row of rows) {
      const list = byCategory.get(row.category) ?? []
      list.push(row)
      byCategory.set(row.category, list)
    }
    return CATEGORY_ORDER
      .map(category => ({ category, rows: byCategory.get(category) ?? [] }))
      .filter(group => group.rows.length > 0)
  }, [rows])

  const commit = useCallback(
    (commandId: string, bindings: readonly Keybinding[]) => {
      setSettings({
        commandKeybindingOverrides: setCommandKeybindings(
          overrides,
          commandId,
          bindings,
          defaults,
        ),
      })
    },
    [overrides, defaults, setSettings],
  )

  // A command's declared binding context, from the shipped defaults table —
  // the same source `effectiveAsDefaults` is derived from, so the conflict
  // check and the router agree about which contexts a chord lives in.
  const contextForCommandId = useCallback(
    (commandId: string): BindingContext =>
      effectiveAsDefaults.find(entry => entry.commandId === commandId)?.context ?? 'global',
    [effectiveAsDefaults],
  )

  const captureRef = useRef<string | null>(null)
  captureRef.current = capturingFor

  // Capture runs on the WINDOW in capture phase, because the workspace router
  // is also listening there. Without preventDefault + stopPropagation the chord
  // being recorded would also EXECUTE — pressing Cmd+W to bind it would close
  // the pane behind the Settings page.
  useEffect(() => {
    if (!capturingFor) return

    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      if (event.key === 'Escape') {
        setCapturingFor(null)
        return
      }

      const binding = keybindingFromEvent(event)
      // null means a bare modifier is held — the user is mid-chord. Waiting
      // rather than erroring is what makes Cmd+Shift+K feel like one gesture.
      if (!binding) return

      const commandId = captureRef.current
      if (!commandId) return

      const owners = findBindingOwners({
        binding,
        // The command's OWN declared context, not 'global'.
        //
        // Hardcoding 'global' made every check maximally pessimistic: 'global'
        // overlaps everything, so binding a grid-only chord reported a conflict
        // with a dispatch-only command that can never be live at the same time.
        // That is precisely the distinction the context system and its disjoint
        // -pair matrix exist to draw, and the one call site that needed it threw
        // it away. Unknown commands fall back to 'global', which errs toward
        // reporting a conflict rather than silently allowing a real one.
        context: contextForCommandId(commandId),
        commandDefaults: effectiveAsDefaults,
        dictationBinding: settings.dictationShortcut,
        excludeCommandId: commandId,
      })

      if (owners.length > 0) {
        // BLOCK the save and name the owners. "That shortcut is taken" is not
        // actionable; "Cmd+T is used by New Tab" is. Registration order and
        // last-write-wins are forbidden — the user decides, explicitly.
        setCapturingFor(null)
        setConflict({
          commandId,
          binding,
          owners: owners.map(owner =>
            owner.kind === 'command' ? commandLabel(owner.id) : owner.id,
          ),
          replaceableCommandIds: owners
            .filter(owner => owner.kind === 'command')
            .map(owner => owner.id),
          hasReservedOwner: owners.some(owner => owner.kind === 'reserved'),
        })
        return
      }

      const current = effective.get(commandId) ?? []
      if (!current.includes(binding)) commit(commandId, [...current, binding])
      setCapturingFor(null)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturingFor, contextForCommandId, effective, effectiveAsDefaults, settings.dictationShortcut, commit])

  /**
   * The ONLY override path. Removes the binding from every command that owns
   * it and installs it on the requester, in ONE settings write — so the store
   * can never be observed with the chord owned twice or by nobody.
   *
   * A reserved interaction cannot be replaced: Escape, native menu roles and
   * editor-native keys are not ours to reassign, so a conflict naming only
   * those offers no Replace at all.
   */
  const applyReplace = useCallback(() => {
    if (!conflict) return
    let next = overrides
    for (const otherId of conflict.replaceableCommandIds) {
      const otherBindings = (effective.get(otherId) ?? []).filter(b => b !== conflict.binding)
      next = setCommandKeybindings(next, otherId, otherBindings, defaults)
    }
    const mine = effective.get(conflict.commandId) ?? []
    next = setCommandKeybindings(next, conflict.commandId, [...mine, conflict.binding], defaults)
    setSettings({ commandKeybindingOverrides: next })
    setConflict(null)
  }, [conflict, overrides, effective, defaults, setSettings])

  return (
    <div className="flex flex-col gap-2">
      <input
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="Search commands, shortcuts, or keywords…"
        className="w-full bg-input-bg border border-border px-2 py-1 text-xs text-ink outline-none focus:border-accent"
      />

      {conflict ? (
        <div className="border border-danger/50 bg-danger/10 px-2 py-1.5 text-xs text-ink">
          <div>
            <span className="font-mono">{displayKeybinding(conflict.binding)}</span>{' '}
            is already used by {conflict.owners.join(', ')}.
          </div>
          <div className="mt-1 flex gap-2">
            {conflict.replaceableCommandIds.length > 0 && !conflict.hasReservedOwner ? (
              <button
                onClick={applyReplace}
                className="border border-border px-1.5 py-0.5 hover:bg-surface"
              >
                Replace
              </button>
            ) : (
              <span className="text-ink-dim">
                Reserved by the app — pick a different chord.
              </span>
            )}
            <button
              onClick={() => setConflict(null)}
              className="border border-border px-1.5 py-0.5 hover:bg-surface"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex max-h-[420px] flex-col gap-2 overflow-auto">
        {grouped.map(group => (
          <div key={group.category} className="flex flex-col gap-0.5">
            <div className="text-[10px] uppercase tracking-wide text-ink-dim">
              {CATEGORY_LABELS[group.category]}
            </div>
            {group.rows.map(row => (
              <div
                key={row.id}
                className="flex items-center gap-2 border border-border/40 px-2 py-1 text-xs"
              >
                <div className="min-w-0 flex-1 truncate text-ink" title={row.id}>
                  {row.title}
                  {PALETTE_SELF_EXCLUDED_COMMAND_IDS.has(row.id) ? (
                    <span className="ml-1 text-ink-dim">(not shown in palette)</span>
                  ) : null}
                </div>

                <div className="flex items-center gap-1">
                  {row.bindings.length === 0 ? (
                    <span className="text-ink-dim">Not assigned</span>
                  ) : (
                    row.bindings.map(binding => (
                      <button
                        key={binding}
                        title="Remove this binding"
                        onClick={() =>
                          commit(row.id, row.bindings.filter(b => b !== binding))
                        }
                        className="border border-border px-1 py-0.5 font-mono hover:border-danger hover:text-danger"
                      >
                        {displayKeybinding(binding)} ×
                      </button>
                    ))
                  )}

                  <button
                    onClick={() => {
                      setConflict(null)
                      setCapturingFor(capturingFor === row.id ? null : row.id)
                    }}
                    className="border border-border px-1.5 py-0.5 hover:bg-surface"
                  >
                    {capturingFor === row.id ? 'Press keys… (Esc)' : 'Add'}
                  </button>

                  {row.customized ? (
                    <button
                      title="Return this command to its shipped default"
                      onClick={() =>
                        setSettings({
                          commandKeybindingOverrides: resetCommandKeybindings(overrides, row.id),
                        })
                      }
                      className="border border-border px-1.5 py-0.5 hover:bg-surface"
                    >
                      Reset
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <button
        onClick={() => setSettings({ commandKeybindingOverrides: {} })}
        className="self-start border border-border px-1.5 py-0.5 text-xs hover:bg-surface"
      >
        Reset all bindings
      </button>
    </div>
  )
}

/** Friendly label for a command id named in a conflict message. */
function commandLabel(commandId: string): string {
  const command = builtInCommandCatalog.find(candidate => candidate.id === commandId)
  if (!command) return commandId
  return typeof command.title === 'function' ? commandId : command.title
}
