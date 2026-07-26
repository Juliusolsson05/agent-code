import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { PALETTE_SELF_EXCLUDED_COMMAND_IDS } from '@renderer/features/command-palette/commands/paletteCommands'
import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
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
}

const CATEGORY_ORDER: CommandCategory[] = [
  'create',
  'navigate',
  'session',
  'layout-dispatch',
  'editor-files',
  'workspace-tools',
  'preferences',
  'developer',
]

type PendingConflict = {
  commandId: string
  binding: Keybinding
  /** Human-readable owners, for a message that NAMES them. */
  owners: string[]
  /** Command ids whose bindings an explicit Replace would remove. */
  replaceableCommandIds: string[]
}

export function CommandKeybindingsRow() {
  const settings = useAppStore(state => state.settings)
  const setSettings = useAppStore(state => state.setSettings)

  const [query, setQuery] = useState('')
  const [capturingFor, setCapturingFor] = useState<string | null>(null)
  const [conflict, setConflict] = useState<PendingConflict | null>(null)
  const [syntaxError, setSyntaxError] = useState<string | null>(null)

  const overrides = settings.commandKeybindingOverrides
  const defaults = useMemo(() => buildDefaultKeybindings(), [])

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
    return builtInCommandCatalog
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
  }, [query, effective, overrides])

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
        setSyntaxError(null)
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
        context: 'global',
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
        })
        return
      }

      const current = effective.get(commandId) ?? []
      if (!current.includes(binding)) commit(commandId, [...current, binding])
      setCapturingFor(null)
      setSyntaxError(null)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturingFor, effective, effectiveAsDefaults, settings.dictationShortcut, commit])

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
            {conflict.replaceableCommandIds.length > 0 ? (
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

      {syntaxError ? (
        <div className="border border-danger/50 px-2 py-1 text-xs text-danger">{syntaxError}</div>
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
