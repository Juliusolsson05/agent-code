import { useEffect, useMemo, useRef, useState } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { buildDefaultKeybindings } from '@renderer/features/command-keybindings/defaults'
import { displayKeybinding } from '@renderer/features/command-keybindings/normalize'
import { resolveEffectiveKeybindings } from '@renderer/features/command-keybindings/resolve'
import type { Keybinding } from '@renderer/features/command-keybindings/normalize'
import type { BindingContext } from '@renderer/features/command-keybindings/defaults'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
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
  grid: 'Grid only',
  dispatch: 'Dispatch only',
  editor: 'Editor only',
  feed: 'Feed only',
}

export function KeyboardShortcutsModal({ open, onClose }: Props) {
  const overrides = useAppStore(state => state.settings.commandKeybindingOverrides)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset the filter on every open. A stale query from last time would present
  // as "most of my shortcuts are missing", which is the one failure this
  // surface cannot afford — it is consulted precisely when the user is already
  // unsure what exists.
  useEffect(() => {
    if (!open) return
    setQuery('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  const rows = useMemo<ShortcutRow[]>(() => {
    const defaults = buildDefaultKeybindings()
    const contextById = new Map(defaults.map(d => [d.commandId, d.context]))
    const effective = new Map(
      resolveEffectiveKeybindings(overrides, defaults).map(e => [e.commandId, e.bindings]),
    )
    const byId = new Map(builtInCommandCatalog.map(c => [c.id, c]))

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
  }, [overrides])

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
      <DialogContent className="flex max-h-[86vh] w-[min(720px,94vw)] flex-col overflow-hidden">
        <div className="flex-shrink-0 border-b border-border px-4 py-3">
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
          <DialogDescription>
            {rows.length} bound command{rows.length === 1 ? '' : 's'}. Change any of them in
            Settings → Keybindings.
          </DialogDescription>
          <input
            ref={inputRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search by command or chord…"
            className="mt-2 w-full border border-border bg-input-bg px-2 py-1 text-xs text-ink outline-none focus:border-accent"
          />
        </div>

        <div className="flex flex-col gap-3 overflow-auto px-4 py-3">
          {grouped.length === 0 ? (
            <div className="py-6 text-center text-xs text-ink-dim">
              No shortcut matches “{query}”.
            </div>
          ) : (
            grouped.map(group => (
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
                      {row.bindings.map(binding => (
                        <span
                          key={binding}
                          className="border border-border bg-surface px-1.5 py-0.5 font-mono text-ink"
                        >
                          {displayKeybinding(binding)}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
