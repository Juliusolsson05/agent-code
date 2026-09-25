import { useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { deriveExtensionCommands, deriveExtensionKeybindings } from '@renderer/apps/host/derive'
import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import { displayKeybinding } from '@renderer/features/command-keybindings/normalize'
import { resolveEffectiveKeybindings } from '@renderer/features/command-keybindings/resolve'
import type { Keybinding } from '@renderer/features/command-keybindings/normalize'
import type { BindingContext } from '@renderer/features/command-keybindings/defaults'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { Input } from '@renderer/components/ui/input'
import { Kbd } from '@renderer/components/ui/kbd'
import type { CommandCategory } from '@renderer/features/command-palette/types'

// ---------------------------------------------------------------------------
// The keyboard shortcut REFERENCE — read-only, for the moment you cannot
// remember a chord.
//
// WHY this is not the Settings keybinding editor. That screen exists to CHANGE
// a binding: it lists all ~98 commands including the ~73 with no chord at all,
// it has capture state, conflict resolution and per-row reset, and it lives
// several clicks deep behind ⌘,. Every one of those properties is wrong for
// "what was the chord for Reader Mode again?" — the answer is buried among
// dozens of rows that have no answer, on a screen that can silently rebind
// something if you fumble a keystroke while it is capturing.
//
// So this shows ONLY commands that have a binding, sorted for scanning, with
// no capture and nothing mutable. It is the thing a user opens mid-task and
// closes two seconds later.
//
// It reads the same `resolveEffectiveKeybindings` the router does, so a user
// who rebound something sees THEIR chord, not the shipped one. A cheat sheet
// that prints defaults would be worse than none — it would be confidently
// wrong for exactly the people who customized, who are the people most likely
// to have forgotten.
// ---------------------------------------------------------------------------

type Props = {
  open: boolean
  onClose: () => void
}

type ShortcutRow = {
  id: string
  title: string
  category: CommandCategory
  bindings: readonly Keybinding[]
  context: BindingContext
  keywords: string[]
  customized: boolean
}

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

/** Display order. Exhaustive by type for the same reason the Settings row is:
 *  a category missing from a hand-listed array would silently drop every
 *  shortcut in it, and a reference with a silent hole is worse than no
 *  reference — the user concludes the chord does not exist. */
const CATEGORY_RANK: Record<CommandCategory, number> = {
  navigate: 0,
  create: 1,
  session: 2,
  'layout-dispatch': 3,
  'editor-files': 4,
  'workspace-tools': 5,
  preferences: 6,
  developer: 7,
  extensions: 8,
}

/**
 * What a context means to a reader.
 *
 * The stored value is a machine word ('grid', 'dispatch'); showing it raw would
 * make the user guess. `global` deliberately renders as nothing at all — most
 * rows are global, and a badge on almost every row carries no information while
 * costing scan time. The badge exists to mark the EXCEPTIONS.
 */
const CONTEXT_LABELS: Record<BindingContext, string | null> = {
  global: null,
  // 'Workspace only': the layout context is the stage now — 'grid' and its
  // label died with the tile grid (#992), and user-facing copy may not name
  // "Dispatch" as a mode (§5.4).
  dispatch: 'Workspace only',
  editor: 'Editor only',
  feed: 'Feed only',
}

export function KeyboardShortcutsModal({ open, onClose }: Props) {
  const overrides = useAppStore(state => state.settings.commandKeybindingOverrides)

  // Extension commands, so a chord a user bound to one is not a silent hole in a
  // reference sheet — the exact failure the CATEGORY_RANK comment above warns
  // against. Derived from manifests (no bundle import); openApp unused here.
  const installedExtensions = useAppStore(state => state.installedExtensions)
  const extensionCommands = useMemo(
    () => deriveExtensionCommands(installedExtensions, () => {}),
    [installedExtensions],
  )
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  // Reset the filter on every open. A stale query from last time would present
  // as "most of my shortcuts are missing", which is the one failure this
  // surface cannot afford — it is consulted precisely when the user is already
  // unsure what exists.
  useEffect(() => {
    if (!open) return
    setQuery('')
    // (Initial focus: DialogContent's onOpenAutoFocus, not a rAF racing
    // Radix's own mount focus.)
  }, [open])

  const rows = useMemo<ShortcutRow[]>(() => {
    // Include extension-contributed defaults so a chord an extension SHIPS (not
    // just one the user rebound) shows in the reference, matching what fires.
    const defaults = [...buildDefaultKeybindings(), ...deriveExtensionKeybindings(installedExtensions)]
    const contextById = new Map(defaults.map(d => [d.commandId, d.context]))
    const effective = new Map(
      resolveEffectiveKeybindings(overrides, defaults).map(e => [e.commandId, e.bindings]),
    )
    const byId = new Map([...builtInCommandCatalog, ...extensionCommands].map(c => [c.id, c]))

    const out: ShortcutRow[] = []
    for (const [commandId, bindings] of effective) {
      // Only bound commands. The ~73 unbound ones are what Settings is for;
      // listing them here would bury the answer among non-answers.
      if (bindings.length === 0) continue
      const command = byId.get(commandId)
      if (!command || !command.category) continue
      out.push({
        id: commandId,
        // A function title needs a CommandContext to resolve, and this modal
        // deliberately has none — it is a reference, not a live view of the
        // workspace. Falling back to the id keeps the row present and
        // identifiable rather than blank.
        title: typeof command.title === 'function' ? commandId : command.title,
        category: command.category,
        bindings,
        context: contextById.get(commandId) ?? 'global',
        keywords: command.keywords ?? [],
        customized: overrides[commandId] !== undefined,
      })
    }
    return out
  }, [overrides, extensionCommands, installedExtensions])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter(row => {
      // Chord text is searchable too, and it matters more than it looks: the
      // other half of "I forgot the shortcut" is "what does ⌥R do again?".
      // Matching on the DISPLAY form means typing what is printed on the row
      // finds it, rather than requiring the internal 'Alt+R' spelling.
      const haystack = [
        row.title,
        row.id,
        CATEGORY_LABELS[row.category],
        ...row.keywords,
        ...row.bindings,
        ...row.bindings.map(displayKeybinding),
      ].join(' ').toLowerCase()
      return haystack.includes(needle)
    })
  }, [rows, query])

  const grouped = useMemo(() => {
    const byCategory = new Map<CommandCategory, ShortcutRow[]>()
    for (const row of filtered) {
      const list = byCategory.get(row.category) ?? []
      list.push(row)
      byCategory.set(row.category, list)
    }
    return (Object.keys(CATEGORY_RANK) as CommandCategory[])
      .sort((a, b) => CATEGORY_RANK[a] - CATEGORY_RANK[b])
      .map(category => ({
        category,
        rows: (byCategory.get(category) ?? []).sort((a, b) => a.title.localeCompare(b.title)),
      }))
      .filter(group => group.rows.length > 0)
  }, [filtered])

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent
        size="lg"
        className="flex max-h-[86vh] flex-col overflow-hidden"
        onOpenAutoFocus={event => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            {rows.length} bound command{rows.length === 1 ? '' : 's'}. Change any of them in
            Settings → Keybindings.
          </DialogDescription>
          {/* The shared Input (plan T4): the hand-rolled field lit an accent
              border on ANY focus, click included. */}
          <Input
            ref={inputRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              // A reference sheet is read by scrolling. PgUp/PgDn page the
              // results from the search box (a single-line field has no use
              // for them), ↓ steps INTO the results so ↑↓ scroll natively.
              if (event.key === 'PageDown' || event.key === 'PageUp') {
                event.preventDefault()
                const region = resultsRef.current
                region?.scrollBy?.({ top: (event.key === 'PageDown' ? 1 : -1) * (region.clientHeight - 24) })
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                resultsRef.current?.focus()
              }
            }}
            aria-label="Search shortcuts"
            placeholder="Search by command or chord…"
            className="mt-2 h-7"
          />
        </DialogHeader>

        {/* The results scroll region is a Tab stop (plan K4) so the keyboard
            can scroll it; a focus ring shows when it has focus. */}
        <div
          ref={resultsRef}
          tabIndex={0}
          aria-label="Shortcuts"
          className="flex min-h-0 flex-col gap-3 overflow-auto px-4 py-3 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ring"
        >
          {grouped.length === 0 ? (
            <div className="py-6 text-center text-[12px] text-ink-dim">
              No shortcut matches “{query}”.
            </div>
          ) : (
            grouped.map(group => (
              <div key={group.category} className="flex flex-col gap-0.5">
                <div className="text-[10px] uppercase tracking-wider text-ink-dim">
                  {CATEGORY_LABELS[group.category]}
                </div>
                {group.rows.map(row => (
                  // Flat rows (plan T7 / "no cards"): these were bordered
                  // rounded plates, one per shortcut.
                  <div
                    key={row.id}
                    className="flex items-center gap-2 border-b border-border/40 px-1 py-1 text-[12px] last:border-b-0"
                  >
                    <div className="min-w-0 flex-1 truncate text-ink" title={row.id}>
                      {row.title}
                      {CONTEXT_LABELS[row.context] ? (
                        <span className="ml-1.5 text-ink-dim">
                          {CONTEXT_LABELS[row.context]}
                        </span>
                      ) : null}
                      {row.customized ? (
                        <span className="ml-1.5 text-accent">customized</span>
                      ) : null}
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-1">
                      {/* The shared Kbd (plan H1/T6): this was a font-mono span
                          styled unlike every other chord in the app. Not
                          aria-hidden — here the chord IS the content. */}
                      {row.bindings.map(binding => (
                        <Kbd key={binding} binding={binding} aria-hidden={false} className="text-ink" />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
        <DialogActions onCancel={onClose} cancelLabel="Close" />
      </DialogContent>
    </Dialog>
  )
}
